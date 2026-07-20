/**
 * opencode-doom-loop — ring-buffer detector
 *
 * Maintains a per-session ring buffer of recent tool-call records and
 * detects two kinds of loops:
 *
 *   **Exact**:  same tool + same SHA-256 of canonical args (after dropping
 *               volatile fields). Catches the "read same file 1000x" pattern.
 *
 *   **Fuzzy**:  same tool + SimHash (64-bit) within a configurable Hamming
 *               distance. Catches near-repetitions where one field (e.g. a
 *               cursor offset) changes slightly.
 *
 * Per-session state is in-memory only. Plugin restart clears it. The buffer
 * is capped at `maxBuffer` entries so long sessions don't leak memory.
 */

import { createHash } from "node:crypto";
import { normalizeArgs } from "./normalize.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CallRecord {
  tool: string;
  exactHash: string;
  fuzzyHash: bigint;
  ts: number;
}

export interface DetectorConfig {
  /** Exact-match consecutive threshold (default 3). */
  threshold: number;
  /** Fuzzy-match consecutive threshold (default 3). */
  fuzzyThreshold: number;
  /** Time window in ms (default 60000). */
  windowMs: number;
  /** Max Hamming distance for fuzzy match (default 3). */
  fuzzyHamming: number;
  /** Per-session ring buffer size cap (default 50). */
  maxBuffer: number;
}

export interface TripEvent {
  sessionID: string;
  tool: string;
  mode: "exact" | "fuzzy";
  count: number;
  windowMs: number;
  lastCalls: Array<{ tool: string; ts: number; argsPreview: string }>;
}

export interface DetectorDeps {
  now?: () => number;
  onTrip?: (event: TripEvent) => void;
}

// ---------------------------------------------------------------------------
// SimHash (64-bit)
// ---------------------------------------------------------------------------

/**
 * Compute a 64-bit SimHash from a normalized args value.
 *
 * Tokenization: walk the normalized structure and emit:
 *   - "key" for each object key
 *   - "key=value" for each key-value pair (string values)
 *   - string values themselves (as additional tokens)
 *
 * For each token, compute SHA-1, take the first 8 bytes as a 64-bit BigInt.
 * Accumulate per-bit weights (+1 for set, -1 for unset) across all tokens.
 * The final hash has bit i = 1 if the cumulative weight > 0.
 */
export function computeFuzzyHash(value: unknown): bigint {
  const tokens: string[] = [];
  collectTokens(normalizeArgs(value), tokens);

  if (tokens.length === 0) return 0n;

  // 64-bit accumulator per bit
  const v = new Int32Array(64);

  for (const token of tokens) {
    const digest = createHash("sha1").update(token).digest();
    // First 8 bytes as BigInt
    let hashBits = 0n;
    for (let i = 0; i < 8; i++) {
      hashBits = (hashBits << 8n) | BigInt(digest[i]);
    }
    // Accumulate per-bit weights
    for (let bit = 0; bit < 64; bit++) {
      if (hashBits & (1n << BigInt(bit))) {
        v[bit]++;
      } else {
        v[bit]--;
      }
    }
  }

  // Build final 64-bit hash
  let result = 0n;
  for (let bit = 0; bit < 64; bit++) {
    if (v[bit] > 0) {
      result |= 1n << BigInt(bit);
    }
  }
  return result;
}

function collectTokens(value: unknown, out: string[]): void {
  if (value === null || value === undefined) return;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) out.push(trimmed);
    return;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    out.push(String(value));
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectTokens(item, out);
    }
    return;
  }

  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    for (const key of keys) {
      out.push(key);
      const sub = (value as Record<string, unknown>)[key];
      if (typeof sub === "string") {
        out.push(`${key}=${sub}`);
      }
      collectTokens(sub, out);
    }
    return;
  }
}

// ---------------------------------------------------------------------------
// Hamming distance (64-bit)
// ---------------------------------------------------------------------------

/**
 * Compute the Hamming distance between two 64-bit BigInts.
 * Uses the standard popcount loop: for a 64-bit value this completes in at
 * most 64 iterations (worst case when all bits differ).
 */
export function hammingDistance(a: bigint, b: bigint): number {
  let x = BigInt.asUintN(64, a) ^ BigInt.asUintN(64, b);
  let count = 0;
  while (x !== 0n) {
    count++;
    x &= x - 1n; // Clear the lowest set bit
  }
  return count;
}

// ---------------------------------------------------------------------------
// DoomLoopDetector
// ---------------------------------------------------------------------------

export class DoomLoopDetector {
  private buffers = new Map<string, CallRecord[]>();

  constructor(
    private config: DetectorConfig,
    private deps: DetectorDeps = {},
  ) {}

  /**
   * Append a call record to the session's buffer, evicting entries outside
   * the time window and trimming to maxBuffer.
   */
  record(sessionID: string, record: CallRecord): void {
    const now = this.deps.now?.() ?? Date.now();
    let buf = this.buffers.get(sessionID);

    if (!buf) {
      buf = [];
      this.buffers.set(sessionID, buf);
    }

    buf.push(record);

    // Evict entries older than windowMs
    const cutoff = now - this.config.windowMs;
    buf = buf.filter((r) => r.ts >= cutoff);

    // Trim to maxBuffer (keep newest)
    if (buf.length > this.config.maxBuffer) {
      buf = buf.slice(buf.length - this.config.maxBuffer);
    }

    this.buffers.set(sessionID, buf);
  }

  /**
   * Check whether the current call triggers a trip.
   * Returns null if no loop detected, or a TripEvent if either exact or
   * fuzzy threshold is met.
   */
  check(
    sessionID: string,
    tool: string,
    exactHash: string,
    fuzzyHash: bigint,
  ): TripEvent | null {
    const buf = this.buffers.get(sessionID);
    if (!buf || buf.length === 0) return null;

    const now = this.deps.now?.() ?? Date.now();
    const cutoff = now - this.config.windowMs;

    // Filter to entries within the window and for the same tool
    const sameTool = buf.filter(
      (r) => r.tool === tool && r.ts >= cutoff,
    );

    if (sameTool.length === 0) return null;

    // --- Exact match ---
    const exactCount = sameTool.filter(
      (r) => r.exactHash === exactHash,
    ).length;
    if (exactCount >= this.config.threshold) {
      const event = this.buildTripEvent(sessionID, tool, "exact", exactCount, sameTool);
      this.deps.onTrip?.(event);
      return event;
    }

    // --- Fuzzy match ---
    const fuzzyCount = sameTool.filter(
      (r) => r.fuzzyHash === fuzzyHash ||
        hammingDistance(r.fuzzyHash, fuzzyHash) <= this.config.fuzzyHamming,
    ).length;
    if (fuzzyCount >= this.config.fuzzyThreshold) {
      const event = this.buildTripEvent(sessionID, tool, "fuzzy", fuzzyCount, sameTool);
      this.deps.onTrip?.(event);
      return event;
    }

    return null;
  }

  /**
   * Clear all records for a session. Call after a trip to let the agent
   * resume with a clean slate.
   */
  reset(sessionID: string): void {
    this.buffers.delete(sessionID);
  }

  /**
   * Total number of buffered records across all sessions.
   */
  size(): number {
    let total = 0;
    for (const buf of this.buffers.values()) {
      total += buf.length;
    }
    return total;
  }

  private buildTripEvent(
    sessionID: string,
    tool: string,
    mode: "exact" | "fuzzy",
    count: number,
    sameTool: CallRecord[],
  ): TripEvent {
    const lastN = sameTool.slice(-Math.min(5, count));
    return {
      sessionID,
      tool,
      mode,
      count,
      windowMs: this.config.windowMs,
      lastCalls: lastN.map((r) => ({
        tool: r.tool,
        ts: r.ts,
        argsPreview: "", // Filled in by the caller with canonicalJSON(args).slice(0, 200)
      })),
    };
  }
}
