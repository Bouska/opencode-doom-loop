import { describe, test, expect } from "bun:test";
import { normalizeArgs, canonicalJSON, exactHash } from "../src/normalize.ts";

// ---------------------------------------------------------------------------
// normalizeArgs
// ---------------------------------------------------------------------------

describe("normalizeArgs", () => {
  test("drops ts/uuid/id/nonce at top level", () => {
    const result = normalizeArgs({
      filePath: "/foo.txt",
      timestamp: "1234567890",
      uuid: "abc-def",
      nonce: "xyz",
      command: "ls -la",
    }) as Record<string, unknown>;
    expect(result.filePath).toBe("/foo.txt");
    expect(result.command).toBe("ls -la");
    expect((result as Record<string, unknown>).timestamp).toBeUndefined();
    expect((result as Record<string, unknown>).uuid).toBeUndefined();
    expect((result as Record<string, unknown>).nonce).toBeUndefined();
  });

  test("drops volatile fields at any nesting depth", () => {
    const result = normalizeArgs({
      query: {
        sql: "SELECT 1",
        sessionId: "ses_abc123",
        callId: "call_456",
        receivedAt: "2024-01-01T00:00:00Z",
      },
      someTimestamp: 12345,
    }) as Record<string, unknown>;
    const query = result.query as Record<string, unknown>;
    expect(query.sql).toBe("select 1");
    expect(query.sessionId).toBeUndefined();
    expect(query.callId).toBeUndefined();
    expect(query.receivedAt).toBeUndefined();
    // someTimestamp is NOT matched by the volatile regex (only exact "ts" is)
    expect((result as Record<string, unknown>).someTimestamp).toBe(12345);
  });

  test("drops all documented volatile field names", () => {
    const input: Record<string, string> = {
      timestamp: "a",
      ts: "b",
      uuid: "c",
      uuidv4: "d",
      nonce: "e",
      randomId: "f",
      sessionID: "g",
      sessionId: "h",
      callID: "i",
      callId: "j",
      createdAt: "k",
      updatedAt: "l",
      receivedAt: "m",
      keepMe: "n",
    };
    const result = normalizeArgs(input) as Record<string, string>;
    expect(result.keepMe).toBe("n");
    // None of the volatile keys should survive
    for (const key of Object.keys(input)) {
      if (key === "keepMe") continue;
      expect((result as Record<string, unknown>)[key]).toBeUndefined();
    }
  });

  test("drops volatile fields case-insensitively", () => {
    const result = normalizeArgs({
      TIMESTAMP: "a",
      Ts: "b",
      SESSIONID: "c",
    }) as Record<string, unknown>;
    expect(result.TIMESTAMP).toBeUndefined();
    expect(result.Ts).toBeUndefined();
    expect(result.SESSIONID).toBeUndefined();
  });

  test("sorts object keys recursively", () => {
    const result = normalizeArgs({
      z: 1,
      a: { m: 2, b: 3, c: { x: 4, y: 5 } },
    }) as Record<string, unknown>;
    const keys = Object.keys(result);
    expect(keys).toEqual(["a", "z"]);
    const a = result.a as Record<string, unknown>;
    expect(Object.keys(a)).toEqual(["b", "c", "m"]);
    const c = a.c as Record<string, unknown>;
    expect(Object.keys(c)).toEqual(["x", "y"]);
  });

  test("lowercases string values", () => {
    const result = normalizeArgs({
      name: "HELLO WORLD",
      path: "/My/Path/  ",
    }) as Record<string, string>;
    expect(result.name).toBe("hello world");
    expect(result.path).toBe("/my/path/");
  });

  test("preserves numbers, booleans, null", () => {
    const result = normalizeArgs({
      count: 42,
      active: true,
      empty: null,
      undef: undefined,
    }) as Record<string, unknown>;
    expect(result.count).toBe(42);
    expect(result.active).toBe(true);
    expect(result.empty).toBeNull();
    expect(result.undef).toBeUndefined();
  });

  test("handles arrays and nested objects", () => {
    const input = {
      items: [
        { B: 2, A: 1, ts: "should-drop" },
        { z: 10, ts: "also-drop" },
      ],
      meta: {
        tags: ["C", "b", "A"],
        ts: 123,
      },
    };
    const result = normalizeArgs(input) as Record<string, unknown>;
    const items = result.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(Object.keys(items[0])).toEqual(["A", "B"]);
    expect(items[0].A).toBe(1);
    expect(items[0].B).toBe(2);
    expect(items[0].ts).toBeUndefined();

    const meta = result.meta as Record<string, unknown>;
    expect(meta.ts).toBeUndefined();
    expect(meta.tags).toEqual(["c", "b", "a"]);
  });

  test("returns null/undefined as-is", () => {
    expect(normalizeArgs(null)).toBeNull();
    expect(normalizeArgs(undefined)).toBeUndefined();
  });

  test("returns primitives as-is", () => {
    expect(normalizeArgs("hello")).toBe("hello");
    expect(normalizeArgs(42)).toBe(42);
    expect(normalizeArgs(true)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// canonicalJSON
// ---------------------------------------------------------------------------

describe("canonicalJSON", () => {
  test("produces identical strings for equivalent-but-key-reordered args", () => {
    const a = canonicalJSON({ b: 2, a: 1, c: { z: 26, y: 25 } });
    const b = canonicalJSON({ c: { y: 25, z: 26 }, a: 1, b: 2 });
    expect(a).toBe(b);
  });

  test("strips volatile fields", () => {
    const withTimestamp = canonicalJSON({ filePath: "foo.txt", timestamp: "123" });
    const without = canonicalJSON({ filePath: "foo.txt" });
    expect(withTimestamp).toBe(without);
  });

  test("two args differing only in a stripped field produce identical output", () => {
    const a = canonicalJSON({ filePath: "x.ts", sessionId: "abc" });
    const b = canonicalJSON({ filePath: "x.ts", sessionId: "xyz" });
    expect(a).toBe(b);
  });

  test("actually different args produce different output", () => {
    const a = canonicalJSON({ filePath: "a.ts" });
    const b = canonicalJSON({ filePath: "b.ts" });
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// exactHash
// ---------------------------------------------------------------------------

describe("exactHash", () => {
  test("is stable across runs", () => {
    const a = exactHash({ filePath: "/foo.txt" });
    const b = exactHash({ filePath: "/foo.txt" });
    expect(a).toBe(b);
  });

  test("differs for genuinely different args", () => {
    const a = exactHash({ filePath: "/foo.txt" });
    const b = exactHash({ filePath: "/bar.txt" });
    expect(a).not.toBe(b);
  });

  test("is identical when only volatile fields differ", () => {
    const a = exactHash({ filePath: "x.ts", sessionId: "abc" });
    const b = exactHash({ filePath: "x.ts", sessionId: "def" });
    expect(a).toBe(b);
  });

  test("produces a hex string of length 64 (SHA-256)", () => {
    const hash = exactHash({ a: 1 });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
