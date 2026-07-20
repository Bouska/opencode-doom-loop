# opencode-doom-loop

An [OpenCode](https://opencode.ai) plugin that prevents agents and subagents from looping on the same tool call. Uses per-session ring buffers with exact (SHA-256 of canonical args) and fuzzy (64-bit SimHash) detection to hard-block repetitive tool calls before they waste time, tokens, and API quota.

## Why this exists

A real incident: an oracle subagent session `ses_0c8105d55ffe51TrOo5QH2GND1` ran `read` 1004 times in 15 minutes with byte-identical args. The built-in V1 `doom_loop` permission (default `"ask"`) silently auto-resolved without prompting, allowing the loop to continue unchecked. This plugin provides a hard, fail-closed guard against such loops via the `tool.execute.before` hook.

## Prerequisites

None — this is a pure TypeScript plugin with no external binary or service dependency.

## Installation

### Option A — `opencode plugin` CLI (recommended)

The official OpenCode CLI installs the plugin and registers it in `opencode.json` in one step:

```bash
# project-level (writes to ./opencode.json)
opencode plugin opencode-doom-loop

# global (writes to ~/.config/opencode/opencode.json)
opencode plugin --global opencode-doom-loop

# pin a specific version
opencode plugin opencode-doom-loop@0.1.0

# replace an existing install
opencode plugin --force opencode-doom-loop
```

Under the hood this runs `bun add` into `~/.cache/opencode/node_modules/` and appends `"opencode-doom-loop"` to the `plugin` array of your `opencode.json`. The plugin auto-loads on the next OpenCode start.

### Option B — npm (manual fallback)

Use this if the CLI is unavailable or you prefer to manage the config by hand:

```bash
# in your project root (or global config)
npm install opencode-doom-loop
```

Then add to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-doom-loop"]
}
```

### Option C — local file (development only)

Build the plugin and copy the output into your `.opencode/plugins/` directory:

```bash
git clone https://github.com/pablomg/opencode-doom-loop.git
cd opencode-doom-loop
bun install && bun run build
cp dist/opencode-doom-loop.js /path/to/project/.opencode/plugins/doom-loop.js
```

OpenCode auto-loads `.js`/`.ts` files placed in `.opencode/plugins/`. The build produces a single bundled `opencode-doom-loop.js` — the SimHash and normalization modules are inlined into the same file, so only one copy is needed. **Do not combine this with Option A or B** — they use separate load paths.

### Uninstalling

The current `opencode plugin` CLI only installs. To remove the plugin:

1. Delete `"opencode-doom-loop"` from the `plugin` array in `opencode.json`.
2. Delete the package cache: `rm -rf ~/.cache/opencode/node_modules/opencode-doom-loop`.
3. If you used Option C, delete the copied file from `.opencode/plugins/`.

> **Note:** A richer subcommand set (`plugin add | list | update | remove`) is tracked in [opencode #7611](https://github.com/anomalyco/opencode/issues/7611).

## How it works

```
agent calls tool with args (e.g. read /foo.txt)
         │
         ▼
┌───────────────────────────────────┐
│  tool.execute.before hook         │
│  normalizeArgs (drop volatile     │
│    fields, sort keys, trim only)  │
└──────────────┬────────────────────┘
               │
               ▼
┌───────────────────────────────────┐
│  exactHash = SHA-256(canonical)   │
│  fuzzyHash = SimHash(64-bit)      │
└──────────────┬────────────────────┘
               │
               ▼
┌───────────────────────────────────┐
│  record() → per-session buffer    │
│  check() → exact / fuzzy compare  │
└──────────────┬────────────────────┘
               │
         ┌─────┴──────┐
         ▼            ▼
    no loop        loop detected
         │            │
         │            ▼
         │    throw Error
         │    (tool call aborted)
         ▼
    tool executes
```

The plugin maintains an in-memory ring buffer per session. Each call record contains the tool name, exact hash, fuzzy hash, and timestamp. Old entries are evicted after the configured time window (`DOOM_LOOP_WINDOW_MS`) or when the buffer exceeds `DOOM_LOOP_MAX_BUFFER` entries.

## Plugin configuration

The plugin reads its own behavior from environment variables (all optional):

| Variable | Default | Description |
|---|---|---|
| `DOOM_LOOP_ENABLED` | `true` | Set to `false`/`0` to disable the plugin entirely. |
| `DOOM_LOOP_THRESHOLD` | `3` | Number of consecutive exact-match calls to trigger a block. |
| `DOOM_LOOP_FUZZY_THRESHOLD` | `3` | Number of consecutive fuzzy-match calls to trigger a block. |
| `DOOM_LOOP_WINDOW_MS` | `60000` | Time window in milliseconds. Calls older than this are discarded. |
| `DOOM_LOOP_FUZZY_HAMMING` | `8` | Max Hamming distance for fuzzy SimHash comparison (max 16). |
| `DOOM_LOOP_MAX_BUFFER` | `50` | Per-session ring buffer size cap. |
| `DOOM_LOOP_EXCLUDE_TOOLS` | `list,todowrite` | Comma-separated tool names to never check. |
| `DOOM_LOOP_INCLUDE_TOOLS` | _(empty)_ | If non-empty, ONLY these tools are checked. |
| `DOOM_LOOP_DEBUG` | `false` | Set to `true`/`1` to emit verbose debug log lines. |
| `DOOM_LOOP_LOG_FILE` | _(empty)_ | File path for JSONL trip log output. Each block appends one JSON line. |

### Detection details

**Exact match**: after normalizing args (dropping volatile fields like `timestamp`, `sessionId`, `uuid`, sorting keys, preserving original case), a SHA-256 hash is computed. If the same tool produces the same hash `DOOM_LOOP_THRESHOLD` times within the window, a loop is detected. This catches the "read same file 1000x" pattern.

**Fuzzy match**: a 64-bit SimHash is computed over the normalized args. Tokens include object keys, `key=value` pairs for strings, and individual string values. If the same tool produces a SimHash within `DOOM_LOOP_FUZZY_HAMMING` bits of previous calls `DOOM_LOOP_FUZZY_THRESHOLD` times, a loop is detected. This catches near-repetitions where one field (e.g. a cursor offset, a page number) changes slightly. Default `8` is empirically chosen for typical small-arg payloads — with ≤10 tokens in the args, a single-field change can flip 4–10 hash bits because the per-bit accumulator is sparse.

### Disabling per-session

There is no per-session config API in v1. To disable the plugin for a specific session, set `DOOM_LOOP_ENABLED=false` in the environment before starting OpenCode.

### Security note

This is a fail-closed guard. False positives are possible — for example, legitimate batch processing over similar files. If the plugin blocks a valid workflow:

1. Raise the threshold: `DOOM_LOOP_THRESHOLD=5` or `DOOM_LOOP_FUZZY_THRESHOLD=5`
2. Tighten the fuzzy Hamming distance (lower = stricter): `DOOM_LOOP_FUZZY_HAMMING=1`
3. Add the tool to `DOOM_LOOP_EXCLUDE_TOOLS`
4. Disable the plugin: `DOOM_LOOP_ENABLED=false`

## Development

```bash
bun install          # install dev dependencies
bun run typecheck    # tsc --noEmit
bun test             # run all tests
bun run build        # bundle to dist/opencode-doom-loop.js
```

## Note on the build output

The build produces a single bundled ESM file. All source modules (normalize, detector) are inlined by bun. The output filename (`opencode-doom-loop.js`) and type declaration file (`opencode-doom-loop.d.ts`) use the renamed form because `package.json` `exports` and `main` reference `dist/opencode-doom-loop.js`.

## License

MIT
