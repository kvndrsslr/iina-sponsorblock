// Pure SponsorBlock logic, ported from po5/mpv_sponsorblock (GPL-3.0).
//
// Everything in this module is free of IINA and mpv globals so it can be unit
// tested with plain node: URL/ID extraction, API response parsing, the range
// filter (skip categories, minimum duration, overlap merge), SHA-256 hashes for
// the privacy mode, and the payloads/URLs of every API call.

const API_PREFIX = "/api/skipSegments";

// The categories po5/mpv_sponsorblock can submit, in its numbering order.
const SUBMITTABLE_CATEGORIES = [
  "sponsor",
  "intro",
  "outro",
  "interaction",
  "selfpromo",
  "preview",
  "music_offtopic",
  "filler",
];

// --- SHA-256 (hash-prefix privacy mode) --------------------------------------

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function utf8Bytes(text) {
  const bytes = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(++i);
      code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    } else {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return bytes;
}

function sha256Hex(text) {
  const bytes = utf8Bytes(text);
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  bytes.push((high >>> 24) & 0xff, (high >>> 16) & 0xff, (high >>> 8) & 0xff, high & 0xff);
  bytes.push((low >>> 24) & 0xff, (low >>> 16) & 0xff, (low >>> 8) & 0xff, low & 0xff);

  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Array(64);

  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      w[i] = ((bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  return h.map((word) => word.toString(16).padStart(8, "0")).join("");
}

function rotr(value, bits) {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

// --- Video ID detection ------------------------------------------------------

const ID_URL_PATTERNS = [
  /ytdl:\/\/([A-Za-z0-9_-]+)/,
  /https?:\/\/youtu\.be\/([A-Za-z0-9_-]+)/,
  /https?:\/\/w?w?w?\.?youtube\.com\/v\/([A-Za-z0-9_-]+)/,
  /\/watch.*[?&]v=([A-Za-z0-9_-]+)/,
  /\/embed\/([A-Za-z0-9_-]+)/,
];

/**
 * Find the YouTube video ID of the playing file.
 * `path` is mpv's path property (a URL for streams), `referer` comes from the
 * http-header-fields property, `purl` from the PURL metadata field, and
 * `localPattern` is a user supplied JS regular expression for local file names.
 */
function youtubeId({ path = "", referer = "", purl = "", extra = "", localPattern = "" } = {}) {
  for (const source of [path, referer, extra]) {
    for (const pattern of ID_URL_PATTERNS) {
      const match = source.match(pattern);
      if (match) return match[1].slice(0, 11);
    }
  }
  if (purl) {
    const match = purl.match(/[?&]v=([A-Za-z0-9_-]{11})/);
    if (match) return match[1];
  }
  if (localPattern) {
    let expression;
    try {
      expression = new RegExp(localPattern);
    } catch (e) {
      return null;
    }
    const match = path.match(expression);
    if (match && match[1] && match[1].length === 11) return match[1];
  }
  return null;
}

// --- API requests ------------------------------------------------------------

function apiBase(server) {
  return String(server || "").replace(/\/+$/, "");
}

/**
 * Build the skipSegments request. With `sha256Length` between 3 and 32 the
 * video ID is replaced by that many hex characters of its SHA-256 hash
 * (privacy mode); otherwise the plain videoID parameter is used.
 */
function fetchRequest({ server, videoId, categories, sha256Length }) {
  const base = apiBase(server);
  const params = { categories: JSON.stringify(categories) };
  const useHash = Number(sha256Length) >= 3 && Number(sha256Length) <= 32;
  if (!useHash) {
    params.videoID = videoId;
    return { url: base + API_PREFIX, params, hashPrefix: null };
  }
  const hashPrefix = sha256Hex(videoId).slice(0, Number(sha256Length));
  return { url: base + API_PREFIX + "/" + hashPrefix, params, hashPrefix };
}

/**
 * Parse the skipSegments response. Returns null when the body is not usable
 * (404 body, malformed JSON), otherwise a list of
 * `{uuid, start, end, category}`. In hash mode the response contains every
 * video sharing the hash prefix, so only the requested video is kept.
 */
function parseSegments(text, { videoId, hashPrefix = null } = {}) {
  if (typeof text !== "string" || text.trim() === "") return null;
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return null;
  }
  if (!Array.isArray(json)) return null;

  const segments = [];
  if (hashPrefix) {
    json.forEach((video) => {
      if (!video || video.videoID !== videoId) return;
      (video.segments || []).forEach((segment) => {
        if (segment) segments.push(toRange(segment));
      });
    });
  } else {
    json.forEach((segment) => segments.push(toRange(segment)));
  }
  return segments.filter(Boolean);
}

function toRange(segment) {
  if (!segment || !Array.isArray(segment.segment) || segment.segment.length < 2) return null;
  const [start, end] = segment.segment;
  if (typeof start !== "number" || typeof end !== "number" || end <= start) return null;
  return {
    uuid: String(segment.UUID || ""),
    start,
    end,
    category: String(segment.category || ""),
  };
}

/**
 * Decide whether a candidate belongs in the range list: the category must be
 * enabled, the segment must last at least `minDuration` seconds, and it must
 * not overlap a segment that is already in the list (the first one wins, as in
 * the original script).
 */
function acceptsRange(candidate, existing, { skipCategories, minDuration = 1 } = {}) {
  if (!candidate) return false;
  if (skipCategories && !skipCategories.includes(candidate.category)) return false;
  if (candidate.end - candidate.start < minDuration) return false;
  return !existing.some(
    (range) =>
      (candidate.start >= range.start && candidate.start <= range.end) ||
      (range.start >= candidate.start && range.start <= candidate.end)
  );
}

/**
 * Merge a freshly fetched segment list into `existing`, keeping ranges that
 * are already known (and therefore may carry a `skipped` flag).
 */
function mergeRanges(existing, candidates, options) {
  const merged = existing.slice();
  candidates.forEach((candidate) => {
    if (!candidate || !candidate.uuid) return;
    if (merged.some((range) => range.uuid === candidate.uuid)) return;
    if (!acceptsRange(candidate, merged, options)) return;
    merged.push(Object.assign({}, candidate, { skipped: false }));
  });
  return merged;
}

// --- Categories -------------------------------------------------------------

function categoryTitle(category) {
  return category.replace(/_/g, " ").replace(/^./, (first) => first.toUpperCase());
}

// --- Skip decisions and playback shaping ------------------------------------

/**
 * Which range, if any, should act at `position`.
 * `mode` is "seek" (jump over the segment) or "fast-forward" (speed up through
 * it); `activeUuid` names the segment currently being fast forwarded.
 * Returns `{action, range}` with action "skip", "fast-forward", "continue"
 * (already fast forwarding) or "none".
 */
function rangeAt(ranges, position, { skipOnce = true, mode = "seek", activeUuid = null } = {}) {
  if (position == null) return { action: "none", range: null };
  for (const range of ranges) {
    if (skipOnce && range.skipped && range.uuid !== activeUuid) continue;
    if (range.start <= position && range.end > position) {
      if (range.uuid === activeUuid) return { action: "continue", range };
      return { action: mode === "seek" ? "skip" : "fast-forward", range };
    }
  }
  return { action: "none", range: null };
}

/** True when a not-yet-skipped range starts within the next second. */
function sponsorAhead(ranges, position, { skipOnce = true } = {}) {
  if (position == null) return false;
  return ranges.some(
    (range) => (!skipOnce || !range.skipped) && range.start <= position + 1 && range.end > position + 1
  );
}

/** Volume for one fade step: clamp between `cap` and `reference`. */
function fadeVolume(current, step, cap, reference) {
  return Math.max(cap, Math.min(current + step, reference));
}

/** Next playback speed while fast forwarding, never above the cap. */
function nextSpeed(current, increase, cap) {
  return Math.min(current + increase, cap);
}

// --- Submissions, votes, views, display name --------------------------------

function timecode(seconds) {
  const whole = Math.max(0, Math.floor(seconds));
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(Math.floor(whole / 3600))}:${pad(Math.floor((whole / 60) % 60))}:${pad(whole % 60)}`;
}

function submitRequest({ server, videoId, start, end, category, userId }) {
  return {
    url: apiBase(server) + API_PREFIX,
    data: {
      videoID: videoId,
      segments: [{ segment: [start, end], category }],
      userID: userId,
    },
  };
}

function voteRequest({ server, uuid, userId, up }) {
  return {
    url: apiBase(server) + "/api/voteOnSponsorTime",
    params: { UUID: uuid, userID: userId, type: up ? "1" : "0" },
  };
}

function viewRequest({ server, uuid }) {
  return { url: apiBase(server) + "/api/viewedVideoSponsorTime", params: { UUID: uuid } };
}

function usernameRequest({ server, userId, name }) {
  return {
    url: apiBase(server) + "/api/setUsername",
    data: { userID: userId, userName: name },
  };
}

function randomUserId(random = Math.random) {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let id = "";
  for (let i = 0; i < 36; i++) id += alphabet[Math.floor(random() * alphabet.length)];
  return id;
}

module.exports = {
  SUBMITTABLE_CATEGORIES,
  sha256Hex,
  youtubeId,
  fetchRequest,
  parseSegments,
  acceptsRange,
  mergeRanges,
  categoryTitle,
  rangeAt,
  sponsorAhead,
  fadeVolume,
  nextSpeed,
  timecode,
  submitRequest,
  voteRequest,
  viewRequest,
  usernameRequest,
  randomUserId,
};
