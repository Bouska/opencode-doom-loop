/**
 * opencode-doom-loop — args canonicalization
 *
 * Transforms tool-call arguments into a canonical form so that byte-level
 * hashing can detect repeated calls that differ only in volatile fields
 * (timestamps, IDs, nonces, etc.).
 *
 * Two strategies:
 *   1. `normalizeArgs` — recursively walk an args object, drop volatile
 *      fields, sort keys alphabetically.
 *   2. `canonicalJSON` — JSON.stringify the normalized form.
 *   3. `exactHash` — SHA-256 of the canonical JSON (fast, deterministic).
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Volatile field matcher
// ---------------------------------------------------------------------------

const VOLATILE_RE =
  /^(timestamp|ts|uuid|uuidv4|nonce|randomId|sessionID|sessionId|callID|callId|createdAt|updatedAt|receivedAt)$/i;

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Recursively normalize an args value:
 *  - Object: drop volatile-keyed fields, sort remaining keys alphabetically,
 *    recurse into each value.
 *  - Array: recurse into each element.
 *  - String: trim only. Original case is preserved for exact-hash purposes.
 *  - number, boolean, null: pass through.
 *  - undefined: pass through (some tools have no args).
 */
export function normalizeArgs(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value.map(normalizeArgs);
  }

  if (typeof value === "object") {
    const entries: Array<[string, unknown]> = [];
    const keys = Object.keys(value as Record<string, unknown>).sort();
    for (const key of keys) {
      if (VOLATILE_RE.test(key)) continue;
      entries.push([key, normalizeArgs((value as Record<string, unknown>)[key])]);
    }
    return Object.fromEntries(entries);
  }

  if (typeof value === "string") {
    return value.trim();
  }

  if (typeof value === "bigint") {
    // BigInt is not serializable by JSON.stringify; coerce to string.
    // This is the most common crash when tool args contain BigInt values.
    return String(value);
  }

  // number, boolean — pass through
  return value;
}

// ---------------------------------------------------------------------------
// Canonical JSON
// ---------------------------------------------------------------------------

/**
 * Serialize the normalized args to a canonical JSON string.
 * Keys are already sorted by `normalizeArgs`, so plain `JSON.stringify`
 * produces deterministic output. A replacer array is NOT used because it
 * would act as a recursive key whitelist and collapse nested objects.
 */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(normalizeArgs(value));
}

// ---------------------------------------------------------------------------
// Exact hash (SHA-256)
// ---------------------------------------------------------------------------

/**
 * Compute a SHA-256 hex digest of the canonical JSON form of the args.
 * Deterministic: same args always produce the same hash (volatile fields
 * stripped first).
 */
export function exactHash(value: unknown): string {
  return createHash("sha256").update(canonicalJSON(value)).digest("hex");
}
