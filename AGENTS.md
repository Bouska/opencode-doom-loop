# AGENTS.md

OpenCode plugin that prevents tool-call doom loops in agents and subagents using
per-session exact (SHA-256) and fuzzy (64-bit SimHash) hashing with configurable
thresholds and time windows.

User-facing install/usage docs live in `README.md`. This file is for agents
working in the repo.

## Stack

- Bun (1.3.x, pinned in CI and `bun-types` devDep) + TypeScript 5.7+ ESM.
- No bundler config, no linter, no formatter. `tsc` + `bun build` only.
- Single workspace. No monorepo packages.
- OpenCode plugin API v1.17+ (`engines.opencode`).

## Source layout

- `src/index.ts` — plugin entry. Exports only `DoomLoopGuard` (named) and
  `default`, so the OpenCode loader sees exactly one function-valued export.
- `src/internal.ts` — internal helpers: `loadConfig`, `formatTripMessage`,
  `appendTripLog`, `createPlugin`, `makeLogger`. Not re-exported from the
  plugin module, keeping the runtime export surface minimal.
- `src/normalize.ts` — args canonicalization: drops volatile fields (ts, uuid,
  sessionId, etc.), sorts object keys, preserves original case (trimmed),
  computes SHA-256.
- `src/detector.ts` — `DoomLoopDetector` class with per-session ring buffers,
  exact-match and fuzzy-match (SimHash + Hamming distance) detection logic.
- `test/normalize.test.ts`, `test/detector.test.ts` — bun test, plain imports
  of `../src/*.ts` (no transpile step).

## Commands

```bash
bun install
bun run typecheck    # tsc --noEmit
bun test             # full unit test suite
bun run build        # produces dist/opencode-doom-loop.{js,d.ts}
```

There is no `lint` or `format` script. Don't invent one.

Run a single test file: `bun test test/detector.test.ts`. Run a single test by
name: `bun test -t "3 identical calls"`.

## Build is non-obvious — read the script before changing it

`package.json` `build`:

1. `rm -rf dist`
2. `tsc --emitDeclarationOnly --outDir dist` (tsconfig has `emitDeclarationOnly: true`)
3. `mv dist/index.d.ts dist/opencode-doom-loop.d.ts` — the published
   type entry is renamed because the runtime entry is renamed next.
4. `bun build src/index.ts --outdir=dist --entry-naming=opencode-doom-loop.js --target=node --format=esm --sourcemap=linked`
5. The support modules `normalize.d.ts` and `detector.d.ts` are kept so the
   renamed entrypoint can resolve its imports. They are listed in
   `package.json` `files` and shipped with the package.

Output: a single ESM file `dist/opencode-doom-loop.js` (with a linked
sourcemap `dist/opencode-doom-loop.js.map`) + three `.d.ts` files. The
plugin loaders look for the `.js` filename; renaming breaks Option A/B
installs. All source modules are inlined into the `.js` bundle — do not
add a second entrypoint unless you also update the load path.

## Config is environment-driven at runtime

All plugin behavior comes from `DOOM_LOOP_*` env vars parsed in `loadConfig()`
(`src/index.ts`). There is no `opencode.json` schema contribution from this
plugin.

Full list:

| Variable | Default | Description |
|---|---|---|
| `DOOM_LOOP_ENABLED` | `true` | Master kill-switch |
| `DOOM_LOOP_THRESHOLD` | `3` | Exact-match consecutive threshold |
| `DOOM_LOOP_FUZZY_THRESHOLD` | `3` | Fuzzy-match consecutive threshold |
| `DOOM_LOOP_WINDOW_MS` | `60000` | Time window in ms |
| `DOOM_LOOP_FUZZY_HAMMING` | `8` | Max Hamming distance for fuzzy (max 16) |
| `DOOM_LOOP_MAX_BUFFER` | `50` | Per-session ring buffer cap |
| `DOOM_LOOP_EXCLUDE_TOOLS` | `list,todowrite` | Never-checked tools |
| `DOOM_LOOP_INCLUDE_TOOLS` | _(empty)_ | Only-checked tools |
| `DOOM_LOOP_DEBUG` | `false` | Debug logging |
| `DOOM_LOOP_LOG_FILE` | _(empty)_ | JSONL trip log path |

## Detection gotchas

- Exact match is byte-level (after normalization). Volatile fields are stripped
  so legitimate retry-with-new-timestamp doesn't trip.
- Fuzzy match is SimHash over tokens with hamming distance ≤
  `DOOM_LOOP_FUZZY_HAMMING` (default 8, max 16). Lower = stricter. Default 8
  is empirically chosen for typical small-arg payloads (3–6 fields) where a
  single field change can flip 4–10 hash bits; with hamming ≤ 3 the fuzzy
  path rarely fires.
- Per-session buffers are in-memory only. Plugin restart clears state. If
  `DOOM_LOOP_LOG_FILE` is set, trips are appended as JSONL for post-mortem.
- Buffer size cap (`DOOM_LOOP_MAX_BUFFER`) prevents unbounded growth in long
  sessions.
- Excluded tools (default `list,todowrite`) are never checked — these are
  commonly called many times in a row by design.

## What an agent is likely to miss

- The single-file build is load-bearing. Don't split into multiple entries or
  change the output filename without updating README install paths.
- `dist/`, `node_modules/`, `*.log` are gitignored. Don't commit any of them.
- The SimHash implementation is 64-bit. With small token sets (≤10 tokens),
  a single-token change can flip 4–10 hash bits because the per-bit
  accumulator is sparse. The default fuzzy hamming of 8 accounts for this.
  If you bump to 128-bit SimHash (future), hamming tolerances can tighten
  back to 3–4.
- `args` may be `undefined` for tools that take no args — the hook skips those
  calls rather than crashing.
- The hook must be sync-fast on the happy path; `appendTripLog` is fire-and-forget.
- No `.opencode/`, `opencode.json`, or `AGENTS.md` other than this one is
  expected at the repo root. If you add one, document why.
