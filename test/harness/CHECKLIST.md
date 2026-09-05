# AP-3/AP-7 Runtime Parity — Manual TUI Checklist

**Why this file exists (honest automation boundary).** The live harness
(`RUN_OPENCODE_HARNESS=1 node test/harness/runtime-parity.mjs`) automates
everything OpenCode's **non-interactive** surface exposes: agent selection via
`run --agent`, the subagent/unknown rejection warnings, the resolved
permission ruleset from `agent list`, and the default-agent binding behavior.
The assertions below additionally require the **interactive TUI** or a
**working model credential**, which no headless surface exposes. They were
therefore not automated; run them by hand after a dashboard restart cycle.

Sandbox note: run against a config you own or a copied sandbox — restarting
OpenCode reads `~/.config/opencode/opencode.json` (CX-3: restart is required
after any dashboard save).

## Prerequisites

1. Create a pipeline in the dashboard (Orchestration → Create agent →
   switch to **Pipeline**) with at least one role — e.g. orchestrator `mypl`
   with role `mypl-build` — or run the automated harness and reuse its
   sandbox config.
2. **Restart OpenCode** so the loader re-reads CONFIG.

## Checklist

- [ ] **Tab cycle** — Press `Tab` to cycle agents in the TUI footer:
      `mypl` appears exactly like built-in primaries; `mypl-build` (hidden
      subagent) NEVER appears.
- [ ] **Agent-list dialog** — Open the agent list (default keybind `Tab`
      cycle / list per your `keybinds` config): the dialog lists `mypl` as a
      primary and does not offer `mypl-build` for selection.
- [ ] **`@` autocomplete** — Type `@` in the prompt input: none of the
      pipeline ROLE names (`mypl-build`, …) are suggested; primaries are.
- [ ] **`--agent` binding (interactive)** — `opencode --agent mypl` (or
      select it in the TUI): the session header binds `mypl` — automatable,
      kept here for the interactive header/`·` model rendering check.
- [ ] **Listed delegation proceeds (credential-bound)** — Inside a `mypl`
      session ask: `Use the Task tool to delegate a trivial question to
mypl-build.` The subagent runs with the invoker's model when the role
      row carries no `model` key (C-R1e inheritance).
- [ ] **Unlisted delegation denied (credential-bound)** — Ask: `Use the Task
tool to delegate to "nosuchbot".` OpenCode refuses via the generated
      `permission.task` map (`"*": "deny"` evaluated last-match-wins after
      the exact-name allows, C-R1f). The ruleset ORDER is automated in
      harness assertion A4; the live refusal is not (needs a model turn).
- [ ] **Default-agent picker** — Set `mypl` via the Orchestration header
      picker, restart: `mypl` boots as the default. Manually writing
      `"default_agent": "mypl-build"` is rejected by the dashboard's write
      gate (AP-7); against raw CONFIG at the pinned 1.18.x run-path the
      observed behavior is a SILENT fallback to a visible primary (recorded
      by harness assertion A5 — do not rely on a loader throw; the dashboard
      gate is the safety net).

## Results log

| Date | OpenCode | Role | Reviewer | Notes |
| ---- | -------- | ---- | -------- | ----- |
|      |          |      |          |       |
