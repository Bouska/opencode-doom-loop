import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DoomLoopDetector,
  computeFuzzyHash,
  hammingDistance,
  type CallRecord,
  type DetectorConfig,
  type TripEvent,
} from "../src/detector.ts";
import { canonicalJSON, exactHash, normalizeArgs } from "../src/normalize.ts";
import { formatTripMessage, appendTripLog, loadConfig } from "../src/index.ts";

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

const baseConfig: DetectorConfig = {
  threshold: 3,
  fuzzyThreshold: 3,
  windowMs: 60000,
  fuzzyHamming: 8,
  maxBuffer: 50,
};

function makeRecord(tool: string, args: unknown): { exactHash: string; fuzzyHash: bigint } {
  return {
    exactHash: exactHash(args),
    fuzzyHash: computeFuzzyHash(args),
  };
}

// ---------------------------------------------------------------------------
// DoomLoopDetector
// ---------------------------------------------------------------------------

describe("DoomLoopDetector", () => {
  test("fresh detector: no trip on first call", () => {
    const d = new DoomLoopDetector(baseConfig);
    const r = makeRecord("read", { filePath: "/foo.txt" });
    d.record("ses_1", { tool: "read", ...r, ts: Date.now() });
    const trip = d.check("ses_1", "read", r.exactHash, r.fuzzyHash);
    expect(trip).toBeNull();
  });

  test("2 distinct calls: no trip", () => {
    const d = new DoomLoopDetector(baseConfig);
    const r1 = makeRecord("read", { filePath: "/foo.txt" });
    const r2 = makeRecord("read", { filePath: "/bar.txt" });
    d.record("ses_1", { tool: "read", ...r1, ts: Date.now() - 1000 });
    d.record("ses_1", { tool: "read", ...r2, ts: Date.now() });
    const trip = d.check("ses_1", "read", r2.exactHash, r2.fuzzyHash);
    expect(trip).toBeNull();
  });

  test("3 identical calls (within window): trip on 3rd with mode exact", () => {
    const d = new DoomLoopDetector(baseConfig);
    const r = makeRecord("read", { filePath: "/foo.txt" });
    const now = Date.now();
    d.record("ses_1", { tool: "read", ...r, ts: now - 2000 });
    d.record("ses_1", { tool: "read", ...r, ts: now - 1000 });
    d.record("ses_1", { tool: "read", ...r, ts: now });
    const trip = d.check("ses_1", "read", r.exactHash, r.fuzzyHash);
    expect(trip).not.toBeNull();
    expect(trip!.mode).toBe("exact");
    expect(trip!.count).toBeGreaterThanOrEqual(3);
    expect(trip!.tool).toBe("read");
  });

  test("3 near-identical calls (hamming distance 0-3): trip on 3rd with mode fuzzy", () => {
    // Use args with many shared fields so SimHash distance stays small
    const shared = { a: "a", b: "b", c: "c", d: "d", e: "e", f: "f", g: "g", h: "h", i: "i", j: "j", k: "k", l: "l", m: "m", n: "n" };
    const r1 = makeRecord("read", shared);
    const r2 = makeRecord("read", { ...shared, n: "O" }); // one char changed
    const r3 = makeRecord("read", { ...shared, n: "p" }); // one char changed
    // Verify hamming distance is small enough
    const dist12 = hammingDistance(r1.fuzzyHash, r2.fuzzyHash);
    const dist23 = hammingDistance(r2.fuzzyHash, r3.fuzzyHash);
    expect(Math.max(dist12, dist23)).toBeLessThanOrEqual(3);
    const d = new DoomLoopDetector({ ...baseConfig, fuzzyHamming: Math.max(dist12, dist23), fuzzyThreshold: 3 });
    const now = Date.now();
    d.record("ses_1", { tool: "read", ...r1, ts: now - 2000 });
    d.record("ses_1", { tool: "read", ...r2, ts: now - 1000 });
    d.record("ses_1", { tool: "read", ...r3, ts: now });
    const trip = d.check("ses_1", "read", r3.exactHash, r3.fuzzyHash);
    expect(trip).not.toBeNull();
    expect(trip!.mode).toBe("fuzzy");
  });

  test("3 calls but different tool name: no trip", () => {
    const d = new DoomLoopDetector(baseConfig);
    const r = makeRecord("read", { filePath: "/foo.txt" });
    const now = Date.now();
    d.record("ses_1", { tool: "bash", ...r, ts: now - 2000 });
    d.record("ses_1", { tool: "bash", ...r, ts: now - 1000 });
    d.record("ses_1", { tool: "read", ...r, ts: now });
    const trip = d.check("ses_1", "read", r.exactHash, r.fuzzyHash);
    expect(trip).toBeNull();
  });

  test("3 calls but different sessionID: no trip", () => {
    const d = new DoomLoopDetector(baseConfig);
    const r = makeRecord("read", { filePath: "/foo.txt" });
    const now = Date.now();
    d.record("ses_1", { tool: "read", ...r, ts: now - 2000 });
    d.record("ses_2", { tool: "read", ...r, ts: now - 1000 });
    d.record("ses_1", { tool: "read", ...r, ts: now });
    const trip = d.check("ses_1", "read", r.exactHash, r.fuzzyHash);
    expect(trip).toBeNull();
  });

  test("calls spanning beyond windowMs: no trip on the 3rd", () => {
    const d = new DoomLoopDetector({ ...baseConfig, windowMs: 100 });
    const r = makeRecord("read", { filePath: "/foo.txt" });
    const start = Date.now() - 500;
    d.record("ses_1", { tool: "read", ...r, ts: start });
    d.record("ses_1", { tool: "read", ...r, ts: start + 50 });
    // The third call happens >100ms after the first two have aged out
    const now = Date.now();
    d.record("ses_1", { tool: "read", ...r, ts: now });
    const trip = d.check("ses_1", "read", r.exactHash, r.fuzzyHash);
    expect(trip).toBeNull();
  });

  test("after trip + reset, new calls start fresh", () => {
    const d = new DoomLoopDetector(baseConfig);
    const r = makeRecord("read", { filePath: "/foo.txt" });
    const now = Date.now();
    d.record("ses_1", { tool: "read", ...r, ts: now - 2000 });
    d.record("ses_1", { tool: "read", ...r, ts: now - 1000 });
    d.record("ses_1", { tool: "read", ...r, ts: now });
    const trip1 = d.check("ses_1", "read", r.exactHash, r.fuzzyHash);
    expect(trip1).not.toBeNull();

    d.reset("ses_1");
    expect(d.size()).toBe(0);

    // Fresh calls should not trip
    const r2 = makeRecord("read", { filePath: "/bar.txt" });
    d.record("ses_1", { tool: "read", ...r2, ts: Date.now() });
    const trip2 = d.check("ses_1", "read", r2.exactHash, r2.fuzzyHash);
    expect(trip2).toBeNull();
  });

  test("buffer capped at maxBuffer", () => {
    const d = new DoomLoopDetector({ ...baseConfig, maxBuffer: 3, windowMs: 100000 });
    const r = makeRecord("read", { filePath: "/foo.txt" });
    const now = Date.now();
    // Record 5 calls
    for (let i = 0; i < 5; i++) {
      d.record("ses_1", { tool: "read", ...r, ts: now - (4 - i) * 10 });
    }
    // Buffer should have at most 3 entries
    expect(d.size()).toBeLessThanOrEqual(3);
    // And they should be the most recent 3
    // We can verify by checking that the detector only sees 3 entries
    // (5 would trip with threshold 3, but since only 3 are kept, it should still trip with those 3)
    const trip = d.check("ses_1", "read", r.exactHash, r.fuzzyHash);
    expect(trip).not.toBeNull();
  });

  test("multiple trips in one session after reset work", () => {
    const d = new DoomLoopDetector(baseConfig);
    const now = Date.now();

    // First loop
    const r1 = makeRecord("read", { filePath: "/a.txt" });
    d.record("ses_1", { tool: "read", ...r1, ts: now - 5000 });
    d.record("ses_1", { tool: "read", ...r1, ts: now - 4000 });
    d.record("ses_1", { tool: "read", ...r1, ts: now - 3000 });
    expect(d.check("ses_1", "read", r1.exactHash, r1.fuzzyHash)).not.toBeNull();

    d.reset("ses_1");

    // Second loop with different args
    const r2 = makeRecord("read", { filePath: "/b.txt" });
    d.record("ses_1", { tool: "read", ...r2, ts: now - 2000 });
    d.record("ses_1", { tool: "read", ...r2, ts: now - 1000 });
    d.record("ses_1", { tool: "read", ...r2, ts: now });
    expect(d.check("ses_1", "read", r2.exactHash, r2.fuzzyHash)).not.toBeNull();
  });

  test("onTrip callback fires on detection", () => {
    let fired: TripEvent | null = null;
    const d = new DoomLoopDetector(baseConfig, {
      onTrip: (e) => { fired = e; },
    });
    const r = makeRecord("read", { filePath: "/foo.txt" });
    const now = Date.now();
    d.record("ses_1", { tool: "read", ...r, ts: now - 2000 });
    d.record("ses_1", { tool: "read", ...r, ts: now - 1000 });
    d.record("ses_1", { tool: "read", ...r, ts: now });
    d.check("ses_1", "read", r.exactHash, r.fuzzyHash);
    expect(fired).not.toBeNull();
    expect(fired!.mode).toBe("exact");
  });
});

// ---------------------------------------------------------------------------
// hammingDistance
// ---------------------------------------------------------------------------

describe("hammingDistance", () => {
  test("same value is distance 0", () => {
    expect(hammingDistance(42n, 42n)).toBe(0);
  });

  test("distance 1", () => {
    // 0b01 vs 0b11 = 1 bit different
    expect(hammingDistance(1n, 3n)).toBe(1);
  });

  test("distance 3", () => {
    // 0b000 (0) vs 0b111 (7) = 3 bits
    expect(hammingDistance(0n, 7n)).toBe(3);
  });

  test("distance 64 (all bits different)", () => {
    const allOnes = (1n << 64n) - 1n;
    expect(hammingDistance(0n, allOnes)).toBe(64);
  });

  test("truncates to 64 bits", () => {
    const big = (1n << 65n) - 1n; // 65 bits of 1s
    expect(hammingDistance(0n, big)).toBe(64); // truncated
  });
});

// ---------------------------------------------------------------------------
// computeFuzzyHash
// ---------------------------------------------------------------------------

describe("computeFuzzyHash", () => {
  test("same args produce same hash", () => {
    const a = computeFuzzyHash({ filePath: "/foo.txt" });
    const b = computeFuzzyHash({ filePath: "/foo.txt" });
    expect(a).toBe(b);
  });

  test("similar args produce close hashes", () => {
    // Args with many shared fields produce SimHashes within 3 bits
    const shared = { a: "a", b: "b", c: "c", d: "d", e: "e", f: "f", g: "g", h: "h", i: "i", j: "j", k: "k", l: "l", m: "m", n: "n" };
    const a = computeFuzzyHash(shared);
    const b = computeFuzzyHash({ ...shared, n: "Z" });
    const dist = hammingDistance(a, b);
    expect(dist).toBeLessThanOrEqual(3);
  });

  test("different args produce different hashes", () => {
    const a = computeFuzzyHash({ filePath: "/a.txt" });
    const b = computeFuzzyHash({ filePath: "/zzzzzzzzzzzzzzzzz" });
    expect(a).not.toBe(b);
  });

  test("empty/null args produce 0n", () => {
    expect(computeFuzzyHash(null)).toBe(0n);
    expect(computeFuzzyHash(undefined)).toBe(0n);
    expect(computeFuzzyHash({})).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// formatTripMessage
// ---------------------------------------------------------------------------

describe("formatTripMessage", () => {
  const config = loadConfig({});

  test("produces the documented format", () => {
    const event: TripEvent = {
      sessionID: "ses_abc123",
      tool: "read",
      mode: "exact",
      count: 3,
      windowMs: 60000,
      lastCalls: [
        { tool: "read", ts: 1000000, argsPreview: '{"filePath":"/foo.txt"}' },
        { tool: "read", ts: 1001000, argsPreview: '{"filePath":"/foo.txt"}' },
        { tool: "read", ts: 1002000, argsPreview: '{"filePath":"/foo.txt"}' },
      ],
    };
    const msg = formatTripMessage("read", event, config);
    expect(msg).toContain("[opencode-doom-loop]");
    expect(msg).toContain("ses_abc123");
    expect(msg).toContain("read");
    expect(msg).toContain("exact");
    expect(msg).toContain("3 matches");
    expect(msg).toContain("Last calls:");
    expect(msg).toContain("/foo.txt");
    expect(msg).toContain("DOOM_LOOP_ENABLED=false");
    expect(msg).toContain("DOOM_LOOP_THRESHOLD=5");
  });

  test("includes ISO timestamps", () => {
    const event: TripEvent = {
      sessionID: "ses_1",
      tool: "bash",
      mode: "fuzzy",
      count: 5,
      windowMs: 30000,
      lastCalls: [
        { tool: "bash", ts: 946684800000, argsPreview: "ls" },
      ],
    };
    const msg = formatTripMessage("bash", event, config);
    expect(msg).toContain(new Date(946684800000).toISOString());
  });
});

// ---------------------------------------------------------------------------
// appendTripLog
// ---------------------------------------------------------------------------

describe("appendTripLog", () => {
  test("writes a JSONL line to a temp file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doom-loop-test-"));
    const file = join(dir, "trips.jsonl");
    try {
      const event: TripEvent = {
        sessionID: "ses_test",
        tool: "read",
        mode: "exact",
        count: 3,
        windowMs: 60000,
        lastCalls: [],
      };
      await appendTripLog(file, event, "read");
      const content = readFileSync(file, "utf-8").trim();
      const parsed = JSON.parse(content);
      expect(parsed.ts).toBeDefined();
      expect(parsed.tool).toBe("read");
      expect(parsed.sessionID).toBe("ses_test");
      expect(parsed.mode).toBe("exact");
      expect(parsed.count).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no-ops when file path is empty", async () => {
    await appendTripLog("", null as unknown as TripEvent, "read");
    // Should not throw
  });
});

// ---------------------------------------------------------------------------
// Consecutive-run counting (Fix 3 — regression tests)
// ---------------------------------------------------------------------------

describe("DoomLoopDetector (consecutive counting)", () => {
  test("3 identical consecutive calls still trip (exact)", () => {
    const d = new DoomLoopDetector(baseConfig);
    const r = makeRecord("read", { filePath: "/a.txt" });
    const now = Date.now();
    d.record("ses_1", { tool: "read", ...r, ts: now - 2000 });
    d.record("ses_1", { tool: "read", ...r, ts: now - 1000 });
    d.record("ses_1", { tool: "read", ...r, ts: now });
    const trip = d.check("ses_1", "read", r.exactHash, r.fuzzyHash);
    expect(trip).not.toBeNull();
    expect(trip!.mode).toBe("exact");
  });

  test("interleaved read /a, read /b, read /a, read /b, read /a does NOT trip", () => {
    // With consecutive-only counting, the streak should be broken by the
    // interleaving different-hash calls.
    const d = new DoomLoopDetector(baseConfig);
    const rA = makeRecord("read", { filePath: "/a.txt" });
    const rB = makeRecord("read", { filePath: "/b.txt" });
    const now = Date.now();
    d.record("ses_1", { tool: "read", ...rA, ts: now - 4000 });
    d.record("ses_1", { tool: "read", ...rB, ts: now - 3000 });
    d.record("ses_1", { tool: "read", ...rA, ts: now - 2000 });
    d.record("ses_1", { tool: "read", ...rB, ts: now - 1000 });
    d.record("ses_1", { tool: "read", ...rA, ts: now });
    const trip = d.check("ses_1", "read", rA.exactHash, rA.fuzzyHash);
    expect(trip).toBeNull();
  });

  test("read /a, read /a, bash ls, read /a does NOT trip (different tool breaks streak)", () => {
    const d = new DoomLoopDetector(baseConfig);
    const rA = makeRecord("read", { filePath: "/a.txt" });
    const rBash = makeRecord("bash", { command: "ls" });
    const now = Date.now();
    d.record("ses_1", { tool: "read", ...rA, ts: now - 3000 });
    d.record("ses_1", { tool: "read", ...rA, ts: now - 2000 });
    d.record("ses_1", { tool: "bash", ...rBash, ts: now - 1000 });
    d.record("ses_1", { tool: "read", ...rA, ts: now });
    const trip = d.check("ses_1", "read", rA.exactHash, rA.fuzzyHash);
    expect(trip).toBeNull();
  });

  test("1 differing call in the middle breaks fuzzy streak too", () => {
    // Set fuzzyThreshold=2, make two close calls then a third that is
    // sufficiently different (but same tool). The third different call
    // should break the streak so the fourth close call does NOT trip.
    const d = new DoomLoopDetector({ ...baseConfig, fuzzyThreshold: 2 });
    const shared = { a: "a", b: "b", c: "c", d: "d", e: "e" };
    const r1 = makeRecord("read", shared);
    // r2 is close to r1
    const r2 = makeRecord("read", { ...shared, e: "E" });
    // rDifferent is completely different args
    const rDiff = makeRecord("read", { z: "zzzzzzzzzz" });
    // r3 is close to r1 again
    const r3 = makeRecord("read", { ...shared, e: "f" });
    const now = Date.now();
    d.record("ses_1", { tool: "read", ...r1, ts: now - 3000 });
    d.record("ses_1", { tool: "read", ...r2, ts: now - 2000 });
    d.record("ses_1", { tool: "read", ...rDiff, ts: now - 1000 }); // breaks streak
    d.record("ses_1", { tool: "read", ...r3, ts: now });
    const trip = d.check("ses_1", "read", r3.exactHash, r3.fuzzyHash);
    // Only entries [rDiff, r3] are consecutive (r3 matches itself, rDiff
    // does not match — it has different args). Actually r3 at the end:
    // walking backward: r3 matches (count=1), rDiff does NOT match (break).
    // So count=1 < threshold=2 => no trip.
    expect(trip).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Window expiry test (explicit time mocking)
// ---------------------------------------------------------------------------

describe("DoomLoopDetector (time mocking)", () => {
  test("window expiry: old records are evicted", () => {
    let fakeNow = 1000000;
    const d = new DoomLoopDetector(
      { ...baseConfig, windowMs: 500 },
      { now: () => fakeNow },
    );
    const r = makeRecord("read", { filePath: "/foo.txt" });

    // Record 3 calls at t=0, t=100, t=200
    fakeNow = 0;
    d.record("ses_1", { tool: "read", ...r, ts: fakeNow });
    fakeNow = 100;
    d.record("ses_1", { tool: "read", ...r, ts: fakeNow });
    fakeNow = 200;
    d.record("ses_1", { tool: "read", ...r, ts: fakeNow });

    // Check at t=200 — should trip (3 calls within 500ms)
    let trip = d.check("ses_1", "read", r.exactHash, r.fuzzyHash);
    expect(trip).not.toBeNull();

    // Now fast-forward to t=1000, record 2 more calls
    // The original 3 should have been evicted from the window during record()
    fakeNow = 1000;
    d.record("ses_1", { tool: "read", ...r, ts: fakeNow });
    fakeNow = 1100;
    d.record("ses_1", { tool: "read", ...r, ts: fakeNow });

    // Only 2 calls in the window, should not trip
    trip = d.check("ses_1", "read", r.exactHash, r.fuzzyHash);
    expect(trip).toBeNull();

    // Add a 3rd, should trip
    fakeNow = 1200;
    d.record("ses_1", { tool: "read", ...r, ts: fakeNow });
    trip = d.check("ses_1", "read", r.exactHash, r.fuzzyHash);
    expect(trip).not.toBeNull();
  });
});
