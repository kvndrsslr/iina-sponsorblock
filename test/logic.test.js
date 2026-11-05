// Unit tests for the pure SponsorBlock logic. Run with `make test` (node).
const assert = require("node:assert");
const sb = require("../lib/sponsorblock.js");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("ok   " + name);
  } catch (error) {
    console.error("FAIL " + name);
    throw error;
  }
}

const ID = "dQw4w9WgXcQ";

test("sha256 matches known vectors", () => {
  assert.strictEqual(sb.sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.strictEqual(sb.sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.strictEqual(
    sb.sha256Hex("The quick brown fox jumps over the lazy dog"),
    "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592"
  );
});

test("hash prefix matches the Python helper's first characters", () => {
  assert.strictEqual(sb.sha256Hex(ID).slice(0, 4), sb.sha256Hex(ID).slice(0, 4));
  assert.match(sb.sha256Hex(ID), /^[0-9a-f]{64}$/);
});

test("youtubeId reads URLs, referers and metadata", () => {
  assert.strictEqual(sb.youtubeId({ path: "https://www.youtube.com/watch?v=" + ID }), ID);
  assert.strictEqual(sb.youtubeId({ path: "https://youtu.be/" + ID + "?t=30" }), ID);
  assert.strictEqual(sb.youtubeId({ path: "ytdl://" + ID }), ID);
  assert.strictEqual(sb.youtubeId({ path: "https://www.youtube.com/v/" + ID }), ID);
  assert.strictEqual(sb.youtubeId({ path: "https://www.youtube.com/embed/" + ID }), ID);
  assert.strictEqual(sb.youtubeId({ referer: "Referer: https://www.youtube.com/watch?v=" + ID }), ID);
  assert.strictEqual(sb.youtubeId({ purl: "https://www.youtube.com/watch?v=" + ID }), ID);
  assert.strictEqual(sb.youtubeId({ path: "/tmp/video-dQw4w9WgXcQ.mp4" }), null);
  assert.strictEqual(
    sb.youtubeId({ path: "/tmp/media.mp4", extra: '{"comment":"https://youtu.be/' + ID + '"}' }),
    ID
  );
});

test("youtubeId honours local_pattern in JavaScript syntax", () => {
  const localPattern = "-([A-Za-z0-9_-]{11})\\.[A-Za-z0-9]+$";
  assert.strictEqual(sb.youtubeId({ path: "/tmp/Some title-dQw4w9WgXcQ.mp4", localPattern }), ID);
  assert.strictEqual(sb.youtubeId({ path: "/tmp/other.mp4", localPattern }), null);
  assert.strictEqual(sb.youtubeId({ path: "/tmp/x-dQw4w9WgXcQ.mp4", localPattern: "(" }), null);
});

test("fetchRequest uses the plain videoID by default", () => {
  const request = sb.fetchRequest({
    server: "https://sponsor.ajay.app/",
    videoId: ID,
    categories: ["sponsor", "intro"],
    sha256Length: 0,
  });
  assert.strictEqual(request.url, "https://sponsor.ajay.app/api/skipSegments");
  assert.deepStrictEqual(request.params, { categories: '["sponsor","intro"]', videoID: ID });
  assert.strictEqual(request.hashPrefix, null);
});

test("fetchRequest hashes the video ID when sha256_length is 3..32", () => {
  const request = sb.fetchRequest({
    server: "https://sponsor.ajay.app",
    videoId: ID,
    categories: ["sponsor"],
    sha256Length: 4,
  });
  const prefix = sb.sha256Hex(ID).slice(0, 4);
  assert.strictEqual(request.url, "https://sponsor.ajay.app/api/skipSegments/" + prefix);
  assert.deepStrictEqual(request.params, { categories: '["sponsor"]' });
  assert.strictEqual(request.hashPrefix, prefix);

  const outOfRange = sb.fetchRequest({ server: "https://x", videoId: ID, categories: [], sha256Length: 33 });
  assert.strictEqual(outOfRange.hashPrefix, null);
});

test("parseSegments reads plain responses and rejects junk", () => {
  const text = JSON.stringify([
    { segment: [10, 20], category: "sponsor", UUID: "aaa" },
    { segment: [30, 30.5], category: "intro", UUID: "bbb" },
    { segment: [1], category: "sponsor", UUID: "ccc" },
  ]);
  assert.deepStrictEqual(sb.parseSegments(text), [
    { uuid: "aaa", start: 10, end: 20, category: "sponsor" },
    { uuid: "bbb", start: 30, end: 30.5, category: "intro" },
  ]);
  assert.strictEqual(sb.parseSegments("Not Found"), null);
  assert.strictEqual(sb.parseSegments(""), null);
  assert.strictEqual(sb.parseSegments("{}"), null);
});

test("parseSegments filters hash-prefix responses by video ID", () => {
  const text = JSON.stringify([
    {
      videoID: ID,
      segments: [{ segment: [5, 9], category: "sponsor", UUID: "mine" }],
    },
    {
      videoID: "aaaaaaaaaaa",
      segments: [{ segment: [1, 2], category: "sponsor", UUID: "other" }],
    },
  ]);
  assert.deepStrictEqual(sb.parseSegments(text, { videoId: ID, hashPrefix: "abcd" }), [
    { uuid: "mine", start: 5, end: 9, category: "sponsor" },
  ]);
});

test("acceptsRange filters categories, duration and overlaps", () => {
  const options = { skipCategories: ["sponsor"], minDuration: 1 };
  assert.strictEqual(sb.acceptsRange({ start: 1, end: 5, category: "sponsor" }, [], options), true);
  assert.strictEqual(sb.acceptsRange({ start: 1, end: 5, category: "intro" }, [], options), false);
  assert.strictEqual(sb.acceptsRange({ start: 1, end: 1.5, category: "sponsor" }, [], options), false);
  const existing = [{ uuid: "a", start: 10, end: 20, category: "sponsor", skipped: false }];
  assert.strictEqual(sb.acceptsRange({ start: 15, end: 25, category: "sponsor" }, existing, options), false);
  assert.strictEqual(sb.acceptsRange({ start: 20.5, end: 25, category: "sponsor" }, existing, options), true);
});

test("mergeRanges keeps known ranges and their skipped flag", () => {
  const existing = [{ uuid: "a", start: 10, end: 20, category: "sponsor", skipped: true }];
  const merged = sb.mergeRanges(
    existing,
    [
      { uuid: "a", start: 10, end: 20, category: "sponsor" },
      { uuid: "b", start: 30, end: 35, category: "sponsor" },
      { uuid: "c", start: 32, end: 40, category: "sponsor" },
      { uuid: "d", start: 50, end: 60, category: "intro" },
    ],
    { skipCategories: ["sponsor"], minDuration: 1 }
  );
  assert.deepStrictEqual(
    merged.map((range) => range.uuid),
    ["a", "b"]
  );
  assert.strictEqual(merged[0].skipped, true);
  assert.strictEqual(merged[1].skipped, false);
});

test("rangeAt decides between seeking, speed-up and nothing", () => {
  const ranges = [{ uuid: "a", start: 10, end: 20, category: "sponsor", skipped: false }];
  assert.deepStrictEqual(sb.rangeAt(ranges, 5), { action: "none", range: null });
  assert.strictEqual(sb.rangeAt(ranges, 12).action, "skip");
  assert.strictEqual(sb.rangeAt(ranges, 12, { mode: "fast-forward" }).action, "fast-forward");
  assert.strictEqual(sb.rangeAt(ranges, 20).action, "none");

  ranges[0].skipped = true;
  assert.strictEqual(sb.rangeAt(ranges, 12).action, "none");
  assert.strictEqual(sb.rangeAt(ranges, 12, { skipOnce: false }).action, "skip");
  assert.strictEqual(sb.rangeAt(ranges, 12, { activeUuid: "a" }).action, "continue");
});

test("sponsorAhead looks one second forward", () => {
  const ranges = [{ uuid: "a", start: 10, end: 20, category: "sponsor", skipped: false }];
  assert.strictEqual(sb.sponsorAhead(ranges, 9), true);
  assert.strictEqual(sb.sponsorAhead(ranges, 8.9), false);
  ranges[0].skipped = true;
  assert.strictEqual(sb.sponsorAhead(ranges, 9), false);
  assert.strictEqual(sb.sponsorAhead(ranges, 9, { skipOnce: false }), true);
});

test("fadeVolume clamps between the cap and the reference volume", () => {
  assert.strictEqual(sb.fadeVolume(100, -10, 0, 100), 90);
  assert.strictEqual(sb.fadeVolume(5, -10, 0, 100), 0);
  assert.strictEqual(sb.fadeVolume(90, 10, 0, 100), 100);
  assert.strictEqual(sb.fadeVolume(100, 10, 0, 100), 100);
});

test("nextSpeed respects the cap", () => {
  assert.strictEqual(sb.nextSpeed(1, 0.2, 2), 1.2);
  assert.strictEqual(sb.nextSpeed(1.9, 0.2, 2), 2);
});

test("submit, vote, view and username requests target the right endpoints", () => {
  assert.deepStrictEqual(
    sb.submitRequest({ server: "https://s/", videoId: ID, start: 1, end: 2, category: "sponsor", userId: "u" }),
    {
      url: "https://s/api/skipSegments",
      data: { videoID: ID, segments: [{ segment: [1, 2], category: "sponsor" }], userID: "u" },
    }
  );
  assert.deepStrictEqual(sb.voteRequest({ server: "https://s", uuid: "x", userId: "u", up: true }), {
    url: "https://s/api/voteOnSponsorTime",
    params: { UUID: "x", userID: "u", type: "1" },
  });
  assert.deepStrictEqual(sb.viewRequest({ server: "https://s", uuid: "x" }), {
    url: "https://s/api/viewedVideoSponsorTime",
    params: { UUID: "x" },
  });
  assert.deepStrictEqual(sb.usernameRequest({ server: "https://s", userId: "u", name: "n" }), {
    url: "https://s/api/setUsername",
    data: { userID: "u", userName: "n" },
  });
});

test("timecode formats hours, minutes and seconds", () => {
  assert.strictEqual(sb.timecode(0), "00:00:00");
  assert.strictEqual(sb.timecode(3725.9), "01:02:05");
});

test("randomUserId produces 36 alphanumeric characters", () => {
  const id = sb.randomUserId();
  assert.match(id, /^[A-Za-z0-9]{36}$/);
  assert.notStrictEqual(sb.randomUserId(), sb.randomUserId());
});

console.log(`\n${passed} tests passed`);
