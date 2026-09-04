# Model Dashboard

A local, single-user web dashboard for editing OpenCode provider/model
configuration and gentle-ai orchestration model assignments in
`~/.config/opencode/opencode.json` (called **CONFIG** below). It is a
surgical config editor, not a generator: it loads the real file, patches
only an allowlist of key paths, validates before anything is written, keeps
timestamped restore points, and replaces the file atomically. Removing the
dashboard leaves CONFIG untouched.

## Quick start

Prerequisites: Node ≥ 22.22.2 and pnpm 11 (pinned via `packageManager`).

```bash
pnpm install
pnpm dev            # server on http://127.0.0.1:8787 + Vite UI on http://localhost:5173
```

Open the Vite URL; it proxies `/api` to the server. If port 8787 is already
held by another process on your machine, stop that process first — the
server binds `127.0.0.1:8787` and fails loudly on collision.

| Command             | What it does                                                          |
| ------------------- | --------------------------------------------------------------------- |
| `pnpm dev`          | tsx-watch server + Vite dev server (proxies `/api`)                   |
| `pnpm build`        | Production bundle to `dist/` (the server then serves it with the API) |
| `pnpm test`         | vitest full suite with coverage (node + jsdom projects)               |
| `pnpm typecheck`    | `tsc --noEmit`                                                        |
| `pnpm lint`         | `eslint .`                                                            |
| `pnpm format:check` | `prettier --check .`                                                  |

## What the dashboard manages

Everything is derived from CONFIG's real keys — provider ids, model ids and
agent names are data, never hardcoded constants, so anything added or
removed externally (including by `gentle-ai sync`) shows up on reload.

| View          | Manages                                                                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Providers     | `provider.<id>.name`, `.npm`, `.options.baseURL`; `.options.apiKey` replace-only, never displayed                                                                                                                  |
| Models        | Whole `provider.<id>.models.<model-id>` entries — add (optionally pre-filled from the bundled NaN snapshot), edit any field, remove behind an explicit confirm; declared-vs-snapshot drift shown as advisory chips |
| Orchestration | `agent.<name>.model` per agent (set a `provider/model` pair or clear to runtime default); prompt bodies and `gentle-ai:*` markers render read-only; "Run sync" executes `gentle-ai sync` server-side               |
| Status        | Read-only: CONFIG path/hash/mtime, drift rollup, backup restore points, restart flag                                                                                                                               |

Writes flow through `PUT`/`POST`/`DELETE /api/*` only; the browser never
touches the filesystem, and every write must echo the hash the last read
reported (see safety model).

## Safety model

| Guarantee                                     | Mechanism                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Key-path allowlist                            | Only `provider.<id>.{name,npm,options.baseURL,options.apiKey}`, `provider.<id>.models.<model-id>` (whole entries), `agent.<name>.{model,description,temperature,variant}` and `default_agent` are writable. Everything else — `$schema`, `compaction`, `instructions`, `mcp`, `share`, unknown keys, prompt bodies, `gentle-ai:*` markers — is rejected before apply, naming the offending path (HTTP 400) |
| Stale-write rejection                         | Each read echoes a SHA-256 of the exact bytes; each write carries it back. Mismatch → 409 before any file mutation, before any backup, with pending edits kept for reload-and-reapply                                                                                                                                                                                                                      |
| Validate before backup                        | Patched trees are schema-validated (offline zod schema generated from `opencode.ai/config.json`, permissive: unknown keys never rejected). Invalid edits produce readable per-path errors and no backup or write happens                                                                                                                                                                                   |
| Per-save backup + atomic replace              | Every accepted save first copies the current file to `model-dashboard-backups/opencode-<ISO>.json` beside CONFIG (newest 20 kept, modes preserved), then writes a hidden same-directory tmp file, fsyncs, chmods to the original mode, and `rename()`s it over CONFIG — readers never observe a truncated file                                                                                             |
| Byte-exact invariant                          | Saves serialize `JSON.stringify(tree, null, 2)` in insertion order (no sorting, no trailing newline). A no-op save leaves the file byte-identical; untouched subtrees keep their exact bytes and key order                                                                                                                                                                                                 |
| apiKey confinement                            | `options.apiKey` values never leave the server: API responses carry only `{ "configured": true                                                                                                                                                                                                                                                                                                             | false }`, the UI never renders or stores a key, and masked shapes are never echoed back as if they were values. The field is replace-only — empty input means "keep the bytes" |
| Localhost-only, offline, no telemetry         | The server binds `127.0.0.1:8787` with no auth (single-user machine). The schema and the NaN catalog snapshot ship inside the app; the dashboard makes zero outbound network calls                                                                                                                                                                                                                         |
| Sync is a pass-through, not a command surface | `gentle-ai sync` runs via `execFile` (shell never involved) with a fixed `['sync', ...]` argv prefix; only `--profile`, `--profile-phase` and `--sdd-profile-strategy` are accepted, each with a validated value shape; anything else is a 400 before spawn. 60 s timeout, 1 MB output cap, exit code and output surfaced honestly (non-zero never renders a success state)                                |
| Restart notice                                | CONFIG has no hot-reload contract: after any successful save the UI shows "Restart OpenCode to apply", and `GET /api/status` reports the same flag process-wide                                                                                                                                                                                                                                            |

## Two backup systems — don't mix them up

| Directory                                     | Written by                                      | Contains                                                                                            | How to restore                                                                                                                                                             |
| --------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.config/opencode/model-dashboard-backups/` | This dashboard, once per accepted save          | Pre-save snapshots of CONFIG (newest 20; `CONFIG_PATH` relocates them beside the file it points at) | Stop OpenCode, copy a backup over CONFIG (`cp "<backup>" "<config path>"` — the Status view shows the newest, ready to copy), restart. The dashboard itself never restores |
| `~/.gentle-ai/backups/`                       | The `gentle-ai` CLI, around its own sync writes | Pre-sync states                                                                                     | `gentle-ai restore` — owned by gentle-ai, not by this app; the two directories are independent                                                                             |

## Sandbox rule (how tests stay safe)

Automated tests **never touch the live `~/.config`**. The fs boundary is
redirected by environment:

- `CONFIG_PATH` — every filesystem-touching unit/integration test points it
  at a temp-directory copy of `test/fixtures/config.sample.json` (a fully
  synthetic fixture). The real CONFIG is never read or written by tests.
- `AUTH_PATH` — auth.json is referenced by existence only, and always
  sandboxed; secret values are never loaded into responses.
- `GENTLE_AI_BIN` — subprocess tests run a local stub binary instead of
  `gentle-ai`; no automated test ever executes the real CLI. Real-binary
  verification runs manually against a sandboxed `HOME` holding copies,
  with live file mtimes verified unchanged afterwards.
- Web tests script `fetch` (jsdom + @testing-library/react) — no network,
  no filesystem.

## Rollback

- **Code**: one revertable Conventional commit per work unit, stacked on
  `main`. Revert newest-first; earlier units don't depend on later ones.
  The stack so far: `757e8f6` (bootstrap) → `8f836a8` (load/mask) →
  `f25628f` (harness fix) → `48025cb` (schema/patch/validate) →
  `6885408` (save pipeline) → `19c4fb3` (REST API) → `52e7c78` (Providers
  view) → `51070b3` (models/snapshot/drift) → `b1d845c` (Orchestration
  view) → `f3ed949` (sync pass-through) → this unit (Status view + polish
  - README; see `git log` for its sha).
- **Config data**: restore the newest `model-dashboard-backups` file (or
  any listed one) with `cp` as described above; use `gentle-ai restore`
  for changes made by `gentle-ai sync`. A 409 rejection path means a
  concurrent external editor can never be clobbered silently.
- **Full uninstall**: delete the app and its backup directory; CONFIG
  itself was never owned by the dashboard and stays in place.

## Layout

```text
server/src/    Hono app: config core (load/mask/patch/validate/save/backup),
               REST routes (/api/*), sync pass-through, bundled NaN snapshot
web/src/       Vite/React console: rail + Providers/Models/Orchestration/Status
               views, api.ts (only network surface), components, styles
shared/        DTOs (shared/types.ts) + committed generated zod schema
tools/         gen-schema.ts — one-time offline schema regeneration
test/          fixtures, unit (node) and integration (app.request()) suites
```
