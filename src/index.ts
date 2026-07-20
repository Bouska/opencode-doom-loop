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

import {
  DoomLoopDetector,
  type DetectorConfig,
} from "./detector.js";
import {
  loadConfig,
  makeLogger,
  createPlugin,
} from "./internal.js";

/**
 * OpenCode plugin entry point.
 *
 * This is the ONLY function export from this module (besides the `default`
 * re-export), so the OpenCode v1.17+ plugin loader — which iterates
 * `Object.values(mod)` and calls each function-valued export as a plugin —
 * finds exactly one candidate. All internal helpers (loadConfig, makeLogger,
 * formatTripMessage, appendTripLog, createPlugin) live in `src/internal.ts`
 * and are NOT re-exported, preventing accidental double-load or crashes.
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
    maxSessions: config.maxSessions,
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
