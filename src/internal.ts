/**
 * opencode-doom-loop — internal helpers (not exported as plugin surface)
 *
 * These functions and types are imported by `src/index.ts` but are NOT
 * re-exported from the plugin module. This prevents the OpenCode v1.17
 * plugin loader from seeing them as candidate plugin entry points.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  DoomLoopDetector,
  computeFuzzyHash,
  type TripEvent,
} from "./detector.js";
import { canonicalJSON, exactHash } from "./normalize.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Plugin behavior configuration, all env-driven. */
export interface DoomLoopConfig {
  /** Master kill-switch. When false, the plugin is a no-op. */
  enabled: boolean;
  /** Exact-match consecutive threshold. */
  threshold: number;
  /** Fuzzy-match consecutive threshold. */
  fuzzyThreshold: number;
  /** Time window in ms for consecutive counting. */
  windowMs: number;
  /** Max Hamming distance for fuzzy match (max 16). */
  fuzzyHamming: number;
  /** Per-session ring buffer size cap. */
  maxBuffer: number;
  /** Comma-separated tool names to NEVER check (default: "list,todowrite"). */
  excludeTools: string[];
  /** If non-empty, ONLY these tools are checked (default: "" = all). */
  includeTools: string[];
  /** When true, emit debug log lines. */
  debug: boolean;
  /** Optional path to append JSONL trip log lines. */
  logFile: string;
}

/** Minimal OpenCode client interface for structured logging. */
type LogClient = {
  app?: {
    log?: (opts: {
      body: { service: string; level: LogLevel; message: string };
    }) => Promise<unknown>;
  };
};

/** Severity levels for the structured plugin logger. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Structured logger — routes through OpenCode's `client.app.log` when available,
 * so messages go to the dedicated logs panel (not raw stderr/stdout that pollutes
 * the TUI). Falls back to a no-op if the client doesn't expose `app.log`.
 */
export type Logger = (level: LogLevel, message: string) => void;

/** Build a Logger from an OpenCode client (duck-typed; safe if missing). */
export function makeLogger(client: unknown): Logger {
  const log = (client as LogClient | undefined)?.app?.log;
  if (!log) return () => {};
  return (level, message) => {
    log({ body: { service: "opencode-doom-loop", level, message } }).catch(() => {});
  };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

type EnvMap = Record<string, string | undefined>;

function envBool(env: EnvMap, name: string, fallback: boolean): boolean {
  const v = env[name];
  if (v === undefined) return fallback;
  const trimmed = v.trim();
  if (trimmed === "") return fallback;
  return /^(1|true|yes|y|on)$/i.test(trimmed);
}

function envInt(env: EnvMap, name: string, fallback: number): number {
  const v = env[name];
  if (v === undefined || v === "") return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envList(env: EnvMap, name: string, fallback: string[]): string[] {
  const v = env[name];
  if (!v) return fallback;
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function envStr(env: EnvMap, name: string, fallback: string): string {
  const v = env[name];
  return v !== undefined && v !== "" ? v : fallback;
}

/**
 * Validate and clamp threshold/fuzzyThreshold against maxBuffer.
 * If a threshold exceeds maxBuffer it is clamped down to maxBuffer.
 * This prevents invariants where the detector could never reach
 * the configured threshold because the buffer is too small.
 */
function clampThresholds(
  threshold: number,
  fuzzyThreshold: number,
  maxBuffer: number,
  debug: boolean,
  logger: Logger,
): { threshold: number; fuzzyThreshold: number } {
  let t = threshold;
  let ft = fuzzyThreshold;
  if (t > maxBuffer) {
    if (debug) logger("debug", `threshold ${t} > maxBuffer ${maxBuffer}, clamping to ${maxBuffer}`);
    t = maxBuffer;
  }
  if (ft > maxBuffer) {
    if (debug) logger("debug", `fuzzyThreshold ${ft} > maxBuffer ${maxBuffer}, clamping to ${maxBuffer}`);
    ft = maxBuffer;
  }
  return { threshold: t, fuzzyThreshold: ft };
}

/**
 * Load plugin config from environment variables.
 *
 * All variables are optional and prefixed `DOOM_LOOP_`:
 *
 *   DOOM_LOOP_ENABLED          — "false"/"0" disables (default true)
 *   DOOM_LOOP_THRESHOLD        — exact-match count (default 3)
 *   DOOM_LOOP_FUZZY_THRESHOLD  — fuzzy-match count (default 3)
 *   DOOM_LOOP_WINDOW_MS        — time window in ms (default 60000)
 *   DOOM_LOOP_FUZZY_HAMMING    — max Hamming distance (default 8, max 16)
 *   DOOM_LOOP_MAX_BUFFER       — per-session buffer cap (default 50)
 *   DOOM_LOOP_EXCLUDE_TOOLS    — never-checked tools (default "list,todowrite")
 *   DOOM_LOOP_INCLUDE_TOOLS    — only-checked tools (default "" = all)
 *   DOOM_LOOP_DEBUG            — verbose logs (default false)
 *   DOOM_LOOP_LOG_FILE         — JSONL trip log path (default "" = off)
 */
export function loadConfig(env: EnvMap = process.env): DoomLoopConfig {
  const debug = envBool(env, "DOOM_LOOP_DEBUG", false);
  // Use a console-based fallback logger for clamp warnings during loadConfig
  const fallbackLogger: Logger = debug
    ? (level, msg) => console.warn(`[opencode-doom-loop] ${level}: ${msg}`)
    : () => {};

  const threshold = envInt(env, "DOOM_LOOP_THRESHOLD", 3);
  const fuzzyThreshold = envInt(env, "DOOM_LOOP_FUZZY_THRESHOLD", 3);
  const maxBuffer = envInt(env, "DOOM_LOOP_MAX_BUFFER", 50);

  const clamped = clampThresholds(threshold, fuzzyThreshold, maxBuffer, debug, fallbackLogger);

  return {
    enabled: envBool(env, "DOOM_LOOP_ENABLED", true),
    threshold: clamped.threshold,
    fuzzyThreshold: clamped.fuzzyThreshold,
    windowMs: envInt(env, "DOOM_LOOP_WINDOW_MS", 60000),
    fuzzyHamming: Math.min(envInt(env, "DOOM_LOOP_FUZZY_HAMMING", 8), 16),
    maxBuffer,
    excludeTools: envList(env, "DOOM_LOOP_EXCLUDE_TOOLS", ["list", "todowrite"]),
    includeTools: envList(env, "DOOM_LOOP_INCLUDE_TOOLS", []),
    debug,
    logFile: envStr(env, "DOOM_LOOP_LOG_FILE", ""),
  };
}

// ---------------------------------------------------------------------------
// Trip message formatting
// ---------------------------------------------------------------------------

/**
 * Format the error message shown when a tool-call loop is detected.
 * Includes the session ID, tool, match mode (exact/fuzzy), count, threshold,
 * and a list of recent calls so the agent can understand what happened.
 */
export function formatTripMessage(
  tool: string,
  event: TripEvent,
  config: DoomLoopConfig,
): string {
  const lines: string[] = [];

  lines.push(`[opencode-doom-loop] Blocked tool-call loop in session ${event.sessionID}`);
  lines.push("");
  lines.push(`  Tool:     ${tool}`);
  lines.push(`  Mode:     ${event.mode}`);
  lines.push(`  Count:    ${event.count} matches in ${event.windowMs}ms (threshold ${event.mode === "exact" ? config.threshold : config.fuzzyThreshold})`);
  lines.push(`  Last calls:`);

  for (let i = 0; i < event.lastCalls.length; i++) {
    const c = event.lastCalls[i];
    const iso = new Date(c.ts).toISOString();
    lines.push(`    ${i + 1}. ${c.tool}(${c.argsPreview}) @ ${iso}`);
  }

  lines.push("");
  lines.push("The agent appears to be repeating the same tool call. Stop and");
  lines.push("summarize what you've learned instead.");
  lines.push("");
  lines.push("To disable this check: set DOOM_LOOP_ENABLED=false");
  lines.push("To raise the threshold: set DOOM_LOOP_THRESHOLD=5");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Trip log (async append)
// ---------------------------------------------------------------------------

/**
 * Append a JSONL line to the trip log file. Creates the directory if it
 * doesn't exist. Fire-and-forget — never blocks the tool-call path.
 */
export async function appendTripLog(
  file: string,
  event: TripEvent,
  tool: string,
): Promise<void> {
  if (!file) return;
  try {
    // Ensure parent directory exists
    const dir = dirname(file);
    if (dir && dir !== ".") {
      await mkdir(dir, { recursive: true }).catch(() => {});
    }
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      tool,
      sessionID: event.sessionID,
      mode: event.mode,
      count: event.count,
      windowMs: event.windowMs,
      lastCalls: event.lastCalls,
    }) + "\n";
    await appendFile(file, line, "utf-8");
  } catch {
    // Best-effort; never throw from a fire-and-forget
  }
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

/**
 * Build the hook handlers for the given config + detector + logger.
 * Exported for testing; use `DoomLoopGuard` for the real plugin.
 */
export function createPlugin(
  config: DoomLoopConfig,
  detector: DoomLoopDetector,
  logger: Logger,
) {
  if (!config.enabled) return {};

  return {
    "tool.execute.before": async (
      input: { tool: string; sessionID?: string; callID?: string },
      output: { args?: unknown },
    ) => {
      // Skip if disabled
      if (!config.enabled) return;

      // Defensive: skip if sessionID is missing
      const sessionID = input.sessionID;
      if (!sessionID) return;

      // Tool filtering
      const tool = input.tool;
      const isExcluded =
        config.excludeTools.includes(tool) &&
        (config.includeTools.length === 0 || !config.includeTools.includes(tool));
      if (isExcluded) return;

      if (config.includeTools.length > 0 && !config.includeTools.includes(tool)) return;

      // Args may be undefined for tools that take no args — skip these
      const args = output?.args;
      if (args === undefined) return;

      // Compute hashes (isolated: bad args must never crash the hook)
      let exact: string;
      let fuzzy: bigint;
      try {
        exact = exactHash(args);
        fuzzy = computeFuzzyHash(args);
      } catch (err) {
        if (config.debug) {
          logger("warn", `[opencode-doom-loop] Hashing failed for ${tool}: ${err}`);
        }
        return;
      }

      const ts = Date.now();

      // Record this call
      detector.record(sessionID, { tool, exactHash: exact, fuzzyHash: fuzzy, ts });

      // Check for trip
      const event = detector.check(sessionID, tool, exact, fuzzy);
      if (event) {
        // Fill in argsPreview
        const preview = canonicalJSON(args).slice(0, 200);
        event.lastCalls = event.lastCalls.map((c) => ({ ...c, argsPreview: preview }));

        // Log
        logger("warn", `[opencode-doom-loop] Trip: ${tool} ${event.mode} count=${event.count} session=${sessionID}`);

        // Append to trip log (fire-and-forget)
        if (config.logFile) {
          appendTripLog(config.logFile, event, tool).catch(() => {});
        }

        // Reset to allow fresh start
        detector.reset(sessionID);

        // Block the call
        throw new Error(formatTripMessage(tool, event, config));
      }

      // Happy path: no loop detected
      if (config.debug) {
        logger("debug", `[opencode-doom-loop] OK: ${tool} session=${sessionID} buffer=${detector.size()}`);
      }
    },
  };
}
