// SponsorBlock for IINA, v2.1
//
// A port of po5/mpv_sponsorblock (GPL-3.0) to IINA's plugin API. The original
// Lua script talks to SponsorBlock through a bundled Python helper, and its key
// bindings never reach IINA. This version uses IINA's own modules: iina.http for
// the API, iina.menu for native menu items and shortcuts, iina.sidebar for the
// segment list, iina.core for OSD, and mpv properties for playback.

const { core, event, http, menu, mpv, preferences, sidebar } = iina;
const sb = require("./lib/sponsorblock.js");

const OSD = "[sponsorblock] ";
const DEFAULT_CATEGORIES = "sponsor,intro,outro,interaction,selfpromo,filler";
const SIDEBAR_PAGE = "ui/sidebar.html";

const state = {
  generation: 0,
  videoId: null,
  ranges: [],
  enabled: true,
  fastForward: false, // false | segment uuid
  speedTimer: null,
  fadeTimer: null,
  fadeDir: null,
  volumeBefore: null,
  lastSkip: { uuid: "", dir: null },
  voted: {}, // uuid -> "1" | "0"
  segment: { a: 0, b: 0, progress: 0, first: true },
  status: "idle",
  statusText: "",
  config: null,
  menuItems: {},
  lastPost: 0,
  lastSignature: "",
};

// --- preferences -----------------------------------------------------------

function pref(key, fallback) {
  const value = preferences.get(key);
  return value === undefined || value === null ? fallback : value;
}

function prefString(key, fallback) {
  const value = pref(key, fallback);
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function prefBool(key, fallback) {
  return pref(key, fallback) === true;
}

function prefNumber(key, fallback) {
  const value = Number(pref(key, fallback));
  return isFinite(value) ? value : fallback;
}

function readConfig() {
  const categories = prefString("categories", DEFAULT_CATEGORIES)
    .split(",")
    .map((category) => category.trim())
    .filter((category) => category.length > 0);
  const skipCategories = prefString("skip_categories", "sponsor")
    .split(",")
    .map((category) => category.trim())
    .filter((category) => category.length > 0);
  return {
    server: prefString("server_address", "https://sponsor.ajay.app"),
    categories: categories.length > 0 ? categories : ["sponsor"],
    skipCategories: skipCategories.length > 0 ? skipCategories : ["sponsor"],
    skip: prefBool("skip", true),
    skipOnce: prefBool("skip_once", true),
    userID: prefString("user_id", ""),
    displayName: prefString("display_name", ""),
    reportViews: prefBool("report_views", true),
    autoUpvote: prefBool("auto_upvote", false),
    minDuration: prefNumber("min_duration", 1),
    audioFade: prefBool("audio_fade", false),
    audioFadeStep: prefNumber("audio_fade_step", 10),
    audioFadeCap: prefNumber("audio_fade_cap", 0),
    fastForward: prefBool("fast_forward", false),
    fastForwardIncrease: prefNumber("fast_forward_increase", 0.2),
    fastForwardCap: prefNumber("fast_forward_cap", 2),
    sha256Length: prefNumber("sha256_length", 4),
    localPattern: prefString("local_pattern", ""),
    keys: {
      toggle: prefString("toggle_key", "b"),
      set: prefString("set_segment_key", "g"),
      submit: prefString("submit_segment_key", "G"),
      up: prefString("upvote_key", "h"),
      down: prefString("downvote_key", "H"),
      sidebar: prefString("sidebar_key", "Meta+Shift+b"),
    },
  };
}

function userId(config) {
  if (config.userID) return config.userID;
  const id = sb.randomUserId();
  preferences.set("user_id", id);
  preferences.sync();
  config.userID = id;
  return id;
}

// --- mpv helpers -----------------------------------------------------------

function getString(name) {
  try {
    const value = mpv.getString(name);
    return typeof value === "string" ? value : "";
  } catch (e) {
    return "";
  }
}

function getNumber(name) {
  try {
    const value = mpv.getNumber(name);
    return typeof value === "number" && isFinite(value) ? value : null;
  } catch (e) {
    return null;
  }
}

// Some sources (yt-dlp, IINA's own ytdl handling) hide the original URL in
// metadata or the playlist instead of the path, so scan those too.
function extraSources() {
  const parts = [];
  try {
    parts.push(JSON.stringify(mpv.getNative("metadata") || {}));
  } catch (e) {}
  try {
    const playlist = mpv.getNative("playlist");
    if (Array.isArray(playlist)) {
      playlist.forEach((entry) => {
        if (entry && typeof entry.filename === "string") parts.push(entry.filename);
      });
    }
  } catch (e) {}
  try {
    parts.push(mpv.getString("stream-open-filename") || "");
  } catch (e) {}
  return parts.join("\n");
}

function stopTimer(timer) {
  if (timer !== null) {
    clearInterval(timer);
    return null;
  }
  return timer;
}

function resetPlaybackShaping() {
  state.fastForward = false;
  state.speedTimer = stopTimer(state.speedTimer);
  state.fadeTimer = stopTimer(state.fadeTimer);
  state.fadeDir = null;
  state.volumeBefore = null;
  if ((getNumber("speed") || 1) !== 1) safeSet("speed", 1);
}

function safeSet(property, value) {
  try {
    mpv.set(property, value);
    return true;
  } catch (e) {
    console.log("SponsorBlock: mpv.set(" + property + ") failed: " + e);
    return false;
  }
}

function safeCommand(name, args) {
  try {
    mpv.command(name, args);
    return true;
  } catch (e) {
    console.log("SponsorBlock: mpv.command(" + name + ") failed: " + e);
    return false;
  }
}

function seekTo(time) {
  const seconds = Math.max(0, Number(time) || 0);
  safeCommand("seek", [String(seconds), "absolute+exact"]);
  postState(true);
}

function setStatus(status, text) {
  state.status = status;
  state.statusText = text || "";
  refreshMenu();
  postState(true);
}

// --- network ---------------------------------------------------------------

function reportSkip(range) {
  const config = state.config;
  if (!state.videoId) return;
  if (!config.reportViews && !config.autoUpvote) return;
  if (config.reportViews) {
    const view = sb.viewRequest({ server: config.server, uuid: range.uuid });
    http.get(view.url, { params: view.params }).catch(() => {});
  }
  if (config.autoUpvote) {
    voteFor(range.uuid, true, { silent: true });
  }
}

async function fetchRanges(config, generation, retries = 1) {
  const request = sb.fetchRequest({
    server: config.server,
    videoId: state.videoId,
    categories: config.categories,
    sha256Length: config.sha256Length,
  });

  let response;
  try {
    response = await http.get(request.url, { params: request.params });
  } catch (e) {
    response = null;
  }
  if (generation !== state.generation) return;

  if (!response || response.statusCode !== 200) {
    if (response && response.statusCode === 404) {
      setStatus("empty", "No segments for this video");
      return;
    }
    if (retries > 0) {
      setTimeout(() => {
        if (generation === state.generation) fetchRanges(config, generation, retries - 1);
      }, 2000);
      return;
    }
    setStatus("error", "Could not reach the SponsorBlock server");
    return;
  }

  const segments = sb.parseSegments(response.text, {
    videoId: state.videoId,
    hashPrefix: request.hashPrefix,
  });
  const before = state.ranges.length;
  state.ranges = sb.mergeRanges(state.ranges, segments || [], {
    skipCategories: config.skipCategories,
    minDuration: config.minDuration,
  });
  if (state.ranges.length === 0) {
    setStatus("empty", "No segments for this video");
  } else {
    const added = state.ranges.length - before;
    setStatus("ready", `${state.ranges.length} segment${state.ranges.length === 1 ? "" : "s"}` +
      (added > 0 ? `, ${added} new` : ""));
  }
}

function refreshSegments() {
  if (!state.videoId) return;
  state.ranges = [];
  setStatus("fetching", "Fetching segments…");
  fetchRanges(state.config, state.generation);
}

// --- skipping --------------------------------------------------------------

function startSpeedRamp() {
  if (state.speedTimer !== null) return;
  const config = state.config;
  state.speedTimer = setInterval(() => {
    const current = getNumber("speed");
    if (current === null) return;
    const next = sb.nextSpeed(current, config.fastForwardIncrease, config.fastForwardCap);
    if (next > current) safeSet("speed", next);
  }, 1000);
}

function startFade(direction) {
  if (state.fadeDir === direction && state.fadeTimer !== null) return;
  state.fadeDir = direction;
  if (state.volumeBefore === null) state.volumeBefore = getNumber("volume");
  state.fadeTimer = stopTimer(state.fadeTimer);
  if (state.volumeBefore === null) return;

  const config = state.config;
  state.fadeTimer = setInterval(() => {
    const current = getNumber("volume");
    if (current === null) return;
    const step = direction ? config.audioFadeStep : -config.audioFadeStep;
    const next = sb.fadeVolume(current, step, config.audioFadeCap, state.volumeBefore);
    if (next === current) {
      if (direction) state.fadeDir = null;
      state.fadeTimer = stopTimer(state.fadeTimer);
      return;
    }
    safeSet("volume", next);
  }, 100);
}

function onTimePos() {
  const config = state.config;
  if (!config) return;

  if (state.enabled && state.ranges.length > 0) {
    const position = getNumber("time-pos");
    const { action, range } = sb.rangeAt(state.ranges, position, {
      skipOnce: config.skipOnce,
      mode: config.fastForward ? "fast-forward" : "seek",
      activeUuid: state.fastForward || null,
    });

    if (action === "skip" || action === "fast-forward") {
      if (action === "skip") {
        core.osd(OSD + range.category + " skipped");
        seekTo(range.end);
      } else {
        core.osd(OSD + "skipping " + range.category);
      }
      range.skipped = true;
      state.lastSkip = { uuid: range.uuid, dir: null };
      reportSkip(range);
      if (action === "fast-forward") {
        state.fastForward = range.uuid;
        startSpeedRamp();
      }
      postState(true);
      return;
    }

    if (action === "none" && position !== null) {
      if (config.audioFade) {
        startFade(!sb.sponsorAhead(state.ranges, position, { skipOnce: config.skipOnce }));
      }
      if (state.fastForward) {
        state.fastForward = false;
        state.speedTimer = stopTimer(state.speedTimer);
        safeSet("speed", 1);
      }
    }
  }

  postState(false);
}

// --- voting ----------------------------------------------------------------

function voteFor(uuid, up, { silent = false } = {}) {
  if (!uuid) {
    if (!silent) core.osd(OSD + "no sponsors skipped, can't submit vote", 3);
    return;
  }
  const direction = up ? "1" : "0";
  if (state.voted[uuid] === direction) {
    if (!silent) core.osd(OSD + (up ? "upvote" : "downvote") + " already submitted", 3);
    return;
  }
  const config = state.config;
  state.voted[uuid] = direction;
  state.lastSkip = { uuid, dir: direction };
  const request = sb.voteRequest({
    server: config.server,
    uuid,
    userId: userId(config),
    up,
  });
  http.get(request.url, { params: request.params }).catch(() => {});
  if (!silent) core.osd(OSD + (up ? "upvote" : "downvote") + " submitted", 3);
  postState(true);
}

function voteLast(up) {
  voteFor(state.lastSkip.uuid, up);
}

// --- submitting ------------------------------------------------------------

function currentSegmentBounds() {
  const { a, b } = state.segment;
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

function setBoundary() {
  if (!state.videoId) {
    core.osd(OSD + "no YouTube video, can't set boundaries", 3);
    return;
  }
  const position = getNumber("time-pos");
  if (position === null) return;

  const segment = state.segment;
  if (segment.progress > 1) segment.progress -= 2;
  if (segment.progress === 1) {
    segment.progress = 0;
    segment.b = position;
    core.osd(OSD + "segment boundary B set, press again for boundary A", 3);
  } else {
    segment.progress = 1;
    segment.a = position;
    core.osd(OSD + "segment boundary A set, press again for boundary B", 3);
  }
  segment.first = false;
  refreshMenu();
  postState(true);
}

function clearBoundaries() {
  state.segment = { a: 0, b: 0, progress: 0, first: true };
  core.osd(OSD + "segment boundaries cleared", 2);
  refreshMenu();
  postState(true);
}

function submitSegment(category) {
  if (!state.videoId) {
    core.osd(OSD + "no YouTube video, can't submit", 3);
    return;
  }
  const { start, end } = currentSegmentBounds();
  if (end === 0 || end - start === 0) {
    core.osd(OSD + "empty segment, not submitting", 3);
    return;
  }

  core.osd(OSD + "submitting " + (category || "sponsor") + " segment...", 10);
  const config = state.config;
  const request = sb.submitRequest({
    server: config.server,
    videoId: state.videoId,
    start,
    end,
    category: category || "sponsor",
    userId: userId(config),
  });

  http
    .post(request.url, { data: request.data, headers: { "Content-Type": "application/json" } })
    .then((response) => {
      const status = response ? response.statusCode : 0;
      if (status === 200) {
        state.segment = { a: 0, b: 0, progress: 0, first: true };
        core.osd(OSD + "segment submitted", 3);
      } else if (status === 409) {
        state.segment = { a: 0, b: 0, progress: 0, first: true };
        core.osd(OSD + "segment already submitted", 3);
      } else if (status === 400) {
        state.segment = { a: 0, b: 0, progress: 0, first: true };
        core.osd(OSD + "segment submission failed, impossible inputs", 5);
      } else if (status === 429) {
        core.osd(OSD + "segment submission failed, rate limited. try again", 5);
      } else if (status === 502) {
        core.osd(OSD + "segment submission failed, server is down. try again", 5);
      } else {
        core.osd(OSD + "segment submission failed", 5);
      }
      refreshMenu();
      postState(true);
    })
    .catch(() => core.osd(OSD + "segment submission failed, server may be down. try again", 5));
}

// --- menu ------------------------------------------------------------------

function buildMenu() {
  const config = state.config || readConfig();
  menu.removeAllItems();

  // IINA only shows the first five first-level items, so everything but the
  // main switch lives in a submenu.
  const toggle = menu.item("Skip Segments", toggleEnabled, {
    selected: state.enabled,
    keyBinding: config.keys.toggle,
  });

  const setBoundaryItem = menu.item("Set Boundary", setBoundary, {
    keyBinding: config.keys.set,
    enabled: state.videoId !== null,
  });
  const clearItem = menu.item("Clear Boundaries", clearBoundaries, {
    enabled: state.segment.progress > 0,
  });
  const submit = menu.item("Submit", () => submitSegment("sponsor"), {
    keyBinding: config.keys.submit,
    enabled: hasBounds(),
  });
  const submitAs = menu.item("Submit As");
  sb.SUBMITTABLE_CATEGORIES.forEach((category) => {
    submitAs.addSubMenuItem(
      menu.item(sb.categoryTitle(category), () => submitSegment(category), { enabled: hasBounds() })
    );
  });
  const segment = menu.item("Segment");
  [setBoundaryItem, clearItem, submit, submitAs].forEach((item) => segment.addSubMenuItem(item));

  const up = menu.item("Upvote Last", () => voteLast(true), {
    keyBinding: config.keys.up,
    enabled: state.lastSkip.uuid !== "",
  });
  const down = menu.item("Downvote Last", () => voteLast(false), {
    keyBinding: config.keys.down,
    enabled: state.lastSkip.uuid !== "",
  });
  const vote = menu.item("Vote");
  [up, down].forEach((item) => vote.addSubMenuItem(item));

  const show = menu.item("Show Segments", () => sidebar.show(), {
    keyBinding: config.keys.sidebar,
  });
  const refresh = menu.item("Refresh Segments", refreshSegments, { enabled: state.videoId !== null });

  [toggle, segment, vote, show, refresh].forEach((item) => menu.addItem(item));

  state.menuItems = { toggle, setBoundaryItem, clearItem, submit, submitAs, up, down, refresh };
  applyMenuState();
  scheduleMenuUpdate();
}

function hasBounds() {
  const { start, end } = currentSegmentBounds();
  return end !== 0 && end > start;
}

function applyMenuState() {
  const items = state.menuItems;
  if (!items.toggle) return;
  items.toggle.selected = state.enabled;
  items.setBoundaryItem.enabled = state.videoId !== null;
  items.clearItem.enabled = state.segment.progress > 0;
  const bounds = hasBounds();
  items.submit.enabled = bounds;
  (items.submitAs.items || []).forEach((item) => (item.enabled = bounds));
  items.up.enabled = state.lastSkip.uuid !== "";
  items.down.enabled = state.lastSkip.uuid !== "";
  items.refresh.enabled = state.videoId !== null;
}

// menu.forceUpdate() re-enters IINA's menu controller, which deadlocks if it
// runs while the plugin script is still being evaluated or before a player
// window exists. Always defer it to the next run loop turn, coalesced.
let menuUpdateScheduled = false;
function scheduleMenuUpdate() {
  applyMenuState();
  if (menuUpdateScheduled) return;
  menuUpdateScheduled = true;
  setTimeout(() => {
    menuUpdateScheduled = false;
    try {
      menu.forceUpdate();
    } catch (e) {
      console.log("SponsorBlock: menu.forceUpdate failed: " + e);
    }
  }, 0);
}

function refreshMenu() {
  scheduleMenuUpdate();
}

let menuBuildScheduled = false;
function scheduleMenuBuild() {
  if (menuBuildScheduled) return;
  menuBuildScheduled = true;
  setTimeout(() => {
    menuBuildScheduled = false;
    try {
      buildMenu();
    } catch (e) {
      console.log("SponsorBlock: menu build failed: " + e);
    }
  }, 0);
}

function toggleEnabled() {
  state.enabled = !state.enabled;
  if (!state.enabled) resetPlaybackShaping();
  core.osd(OSD + (state.enabled ? "on" : "off"), 2);
  refreshMenu();
  postState(true);
}

// --- sidebar ---------------------------------------------------------------

function sidebarPayload() {
  const position = getNumber("time-pos");
  const segments = state.ranges
    .slice()
    .sort((a, b) => a.start - b.start)
    .map((range) => ({
      uuid: range.uuid,
      start: range.start,
      end: range.end,
      category: range.category,
      skipped: Boolean(range.skipped),
      current: position !== null && range.start <= position && range.end > position,
      voted: state.voted[range.uuid] || "",
    }));
  const { start, end } = currentSegmentBounds();
  return {
    videoId: state.videoId,
    status: state.status,
    statusText: state.statusText,
    enabled: state.enabled,
    skipCategories: state.config ? state.config.skipCategories : [],
    categories: sb.SUBMITTABLE_CATEGORIES,
    position,
    duration: getNumber("duration"),
    segments,
    boundaries: { start: end > start ? start : null, end: end > start ? end : null },
    lastSkipUuid: state.lastSkip.uuid,
  };
}

function postState(force) {
  if (!state.config) return;
  const now = Date.now();
  if (!force && now - state.lastPost < 750) return;
  state.lastPost = now;

  const payload = sidebarPayload();
  const signature = payload.segments
    .map((segment) => `${segment.uuid}:${segment.skipped ? 1 : 0}:${segment.voted}`)
    .join(",");
  payload.signature = signature;
  payload.rebuild = signature !== state.lastSignature;
  state.lastSignature = signature;
  try {
    sidebar.postMessage("state", payload);
  } catch (e) {
    // The sidebar webview can be unavailable before its page finishes loading.
  }
}

function handleSidebarCommand(data) {
  if (!data || typeof data.action !== "string") return;
  console.log("SponsorBlock: sidebar command " + data.action);
  switch (data.action) {
    case "toggle":
      toggleEnabled();
      break;
    case "seek":
      seekTo(data.time);
      break;
    case "vote":
      voteFor(String(data.uuid || ""), Boolean(data.up));
      break;
    case "set-boundary":
      setBoundary();
      break;
    case "clear-boundaries":
      clearBoundaries();
      break;
    case "submit":
      submitSegment(String(data.category || "sponsor"));
      break;
    case "refresh":
      refreshSegments();
      break;
    case "show-menu":
      sidebar.show();
      break;
    default:
      break;
  }
}

// --- lifecycle -------------------------------------------------------------

function updateDisplayName(config) {
  if (!config.displayName) return;
  const request = sb.usernameRequest({
    server: config.server,
    userId: userId(config),
    name: config.displayName,
  });
  http.post(request.url, { data: request.data }).catch(() => {});
}

event.on("iina.file-loaded", () => {
  const config = readConfig();
  state.config = config;
  const generation = ++state.generation;

  state.ranges = [];
  state.enabled = config.skip;
  state.lastSkip = { uuid: "", dir: null };
  state.voted = {};
  state.segment = { a: 0, b: 0, progress: 0, first: true };
  resetPlaybackShaping();

  state.videoId = sb.youtubeId({
    path: getString("path"),
    referer: getString("http-header-fields"),
    purl: getString("metadata/by-key/PURL"),
    extra: extraSources(),
    localPattern: config.localPattern,
  });

  if (!state.videoId) {
    setStatus("not-youtube", "This file has no YouTube video ID");
  } else {
    setStatus("fetching", "Fetching segments…");
    updateDisplayName(config);
    fetchRanges(config, generation);
  }

  scheduleMenuBuild();
  postState(true);
});

event.on("mpv.time-pos.changed", onTimePos);

let sidebarLoaded = false;
event.on("iina.window-loaded", () => {
  if (!sidebarLoaded) {
    sidebarLoaded = true;
    sidebar.loadFile(SIDEBAR_PAGE);
    // loadFile() clears the sidebar message listeners, so this must come after it.
    sidebar.onMessage("command", handleSidebarCommand);
  }
  scheduleMenuBuild();
  postState(true);
});

// The sidebar page can load after the first state message, and a paused player
// produces no time-pos updates, so keep it fed.
setInterval(() => postState(false), 1000);
