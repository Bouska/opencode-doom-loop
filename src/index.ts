/**
 * opencode-doom-loop
 *
 * OpenCode plugin that prevents a single agent (especially subagents) from
 * looping on the same tool call. Uses per-session ring buffers with exact
 * (SHA-256 of canonical args) and fuzzy (64-bit SimHash with configurable
 * Hamming distance) detection.
 *
 * Inspired by a real incident: an oracle subagent ran `read` 1004 times in
 * 15 minutes with byte-identical args. The built-in V1 `doom_loop` permission
 * (default "ask") silently auto-resolved without prompting. This plugin
 * hard-blocks these loops via the `tool.execute.before` hook.
 *
 * When a loop is detected, the hook throws an Error to abort the tool call.
 * The thrown message includes the session ID, tool name, match mode
 * (exact/fuzzy), match count, and a list of recent calls so the agent can
 * understand why it was blocked.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  DoomLoopDetector,
  computeFuzzyHash,
  type DetectorConfig,
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

/** Minimal OpenCode client interface for future use (v1 compatibility). */
export interface OpencodeSessionClient {
  session: {
    create(options?: {
      body?: { title?: string };
    }): Promise<{ data?: { id?: string } }>;
    prompt(options: {
      path: { id: string };
      body: {
        agent?: string;
        model?: { providerID: string; modelID: string };
        system?: string;
        parts: Array<{ type: "text"; text: string }>;
      };
      signal?: AbortSignal;
    }): Promise<{
      data?: { parts?: Array<{ type: string; text?: string }> };
    }>;
    messages(options: {
      path: { id: string };
      query?: { limit?: number };
    }): Promise<{
      data?: Array<{
        info: { role: "user" | "assistant" };
        parts: Array<{ type: string; text?: string; tool?: string }>;
      }>;
    }>;
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
  return {
    enabled: envBool(env, "DOOM_LOOP_ENABLED", true),
    threshold: envInt(env, "DOOM_LOOP_THRESHOLD", 3),
    fuzzyThreshold: envInt(env, "DOOM_LOOP_FUZZY_THRESHOLD", 3),
    windowMs: envInt(env, "DOOM_LOOP_WINDOW_MS", 60000),
    fuzzyHamming: Math.min(envInt(env, "DOOM_LOOP_FUZZY_HAMMING", 8), 16),
    maxBuffer: envInt(env, "DOOM_LOOP_MAX_BUFFER", 50),
    excludeTools: envList(env, "DOOM_LOOP_EXCLUDE_TOOLS", ["list", "todowrite"]),
    includeTools: envList(env, "DOOM_LOOP_INCLUDE_TOOLS", []),
    debug: envBool(env, "DOOM_LOOP_DEBUG", false),
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

      // Compute hashes
      const exact = exactHash(args);
      const fuzzy = computeFuzzyHash(args);
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

/**
 * OpenCode plugin entry point.
 *
 * Register in `opencode.json`:
 *   { "plugin": ["opencode-doom-loop"] }
 *
 * Or place the built file in `.opencode/plugins/`.
 *
 * All configuration is via `DOOM_LOOP_*` environment variables.
 */
export const DoomLoopGuard = async (context: {
  project: unknown;
  client: unknown;
  $: unknown;
  directory: string;
  worktree: string;
}) => {
  const config = loadConfig();
  const logger = makeLogger(context.client);

  const detectorConfig: DetectorConfig = {
    threshold: config.threshold,
    fuzzyThreshold: config.fuzzyThreshold,
    windowMs: config.windowMs,
    fuzzyHamming: config.fuzzyHamming,
    maxBuffer: config.maxBuffer,
  };

  const detector = new DoomLoopDetector(detectorConfig);

  return createPlugin(config, detector, logger);
};

/**
 * OpenCode's plugin loader (v1.17+) expects a `default` export. Most
 * OpenCode plugins (e.g. oh-my-opencode-slim) export the plugin function
 * itself as `default`; re-export `DoomLoopGuard` here so the plugin is
 * importable as both a named and default export.
 */
export default DoomLoopGuard;
