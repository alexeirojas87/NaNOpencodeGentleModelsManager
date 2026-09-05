#!/usr/bin/env node
// agent-pipelines WU-5 task 5.3 — AP-3/AP-7 RUNTIME PARITY (LIVE, opt-in per
// the maintainer resolution recorded in apply-progress #479: automate what
// OpenCode's NON-INTERACTIVE surface allows; pure TUI keystrokes stay in
// test/harness/CHECKLIST.md).
//
// Opt-in:  RUN_OPENCODE_HARNESS=1 node test/harness/runtime-parity.mjs
// Default (env unset): prints SKIP with the reason and exits 0 — this probe
// runs the real binary against a network-failing model call, so it is
// credential-free but not CI-stable (boot ~1-3s per probe; the decisive line
// lands early and the child is killed — the API-connect tail is ignored).
//
// Assertions (sandbox HOME only; live ~/.config proven untouched):
//   A1 the orchestrator is SELECTABLE: `opencode run --agent mypl` binds —
//      the session header shows `> mypl` (identical surface to built-in
//      primaries; C-R1a/c).
//   A2 roles are ABSENT from primary resolution: `run --agent mypl-build`
//      answers `is a subagent, not a primary agent` (C-R1d family).
//   A3 contrast baseline: an unknown name answers `not found. Falling back`
//      — A1's silence is real selection, not a broken checker.
//   A4 UNLISTED TASK DELEGATION DENIED, at the resolved-ruleset level: the
//      orchestrator's evaluated permission list (from `opencode agent list`)
//      shows task `*` deny ordered BEFORE the role/helper allows — under the
//      last-match-wins evaluator (C-R1f) any unlisted target matches only
//      the deny. (A full LLM-driven refusal requires credentials: CHECKLIST.)
//   A5 hidden-role as default_agent never binds: with `default_agent:
//      "mypl-build"` the run must NEVER bind the role. Observed at pin
//      1.18.29: an error exit before any header (C-R1d throw family); a
//      silent fallback to a visible primary was also seen with variant
//      configs — both satisfy the invariant, recorded honestly per run.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import {
  baseTree,
  cleanup,
  createPipelineViaApi,
  ensureTsxChild,
  installSandboxHome,
  liveProof,
  mkSandbox,
  readTree,
  reportProof,
  skipOr,
  spawnWatch,
  versionLine,
  writeConfig,
} from './_support.mjs';

if (process.env.RUN_OPENCODE_HARNESS !== '1') {
  console.log(
    'SKIP: runtime-parity is opt-in (RUN_OPENCODE_HARNESS=1) — it spawns the real opencode binary per probe. The non-interactive assertions below run in ~10s when enabled; TUI keystrokes live in CHECKLIST.md.',
  );
  process.exit(0);
}

ensureTsxChild(import.meta.url);

const OPENCODE = process.env.OPENCODE_BIN || 'opencode';
const version = versionLine(OPENCODE);
skipOr(version !== null, OPENCODE, 'runtime parity needs the real binary');
console.log(`harness 5.3 runtime-parity — ${version}`);

const HEADER = /^\s*>\s+(\S+)\s+·/m;
const REJECT_SUBAGENT = /agent "([^"]+)" is a subagent, not a primary agent/;
const REJECT_NOT_FOUND =
  /agent "([^"]+)" not found\. Falling back to default agent/;

const before = liveProof();
const base = mkSandbox('mdash-harness-parity-');
let failed = false;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name} — ${detail}`);
  if (!ok) failed = true;
};

try {
  const home = installSandboxHome(base);
  const configPath = writeConfig(home, baseTree());
  await createPipelineViaApi(configPath, base);

  // A4 — resolved ruleset order at boot (OpenCode's own permission render).
  const list = spawnSync(OPENCODE, ['agent', 'list'], {
    env: { ...process.env, HOME: home },
    cwd: home,
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (list.status !== 0) {
    console.log(String(list.stderr || list.stdout).slice(0, 400));
    throw new Error('agent list exited non-zero');
  }
  const clean = (list.stdout || '').replace(/\u001b\[[0-9;]*m/g, '');
  const section =
    /\nmypl \(primary\)\n([\s\S]*?)(?=\n\S.*\((?:primary|subagent|all)\)\n|$)/.exec(
      clean,
    );
  const block = section ? section[1] : '';
  const taskRows = [
    ...block.matchAll(
      /"permission": "task",\s*"pattern": "([^"]+)",\s*"action": "(\w+)"/g,
    ),
  ].map((m) => [m[1], m[2]]);
  const denyStarIdx = taskRows.findIndex(([p, a]) => p === '*' && a === 'deny');
  const allowIdx = taskRows.findIndex(
    ([p, a]) => p === 'mypl-build' && a === 'allow',
  );
  check(
    'A4 unlisted-task delegation denied (resolved order)',
    denyStarIdx === 0 && allowIdx > denyStarIdx,
    `task rows ${JSON.stringify(taskRows)} — '*' deny precedes allows ⇒ last-match-wins denies unlisted names (C-R1f)`,
  );

  const runProbe = (args) =>
    spawnWatch(OPENCODE, args, home, [
      ['SUBAGENT_REJECT', REJECT_SUBAGENT],
      ['NOT_FOUND', REJECT_NOT_FOUND],
      ['HEADER', HEADER],
    ]);

  // A1 — orchestrator selectable.
  const a1 = await runProbe(['run', '--agent', 'mypl', 'say hi']);
  const bound = a1.text.match(HEADER);
  check(
    'A1 orchestrator selectable via --agent',
    a1.kind === 'HEADER' && bound && bound[1] === 'mypl',
    `${a1.kind} ${a1.ms}ms header=${bound ? bound[1] : '—'} (API-connect tail expected and killed)`,
  );

  // A2 — role absent from primary resolution.
  const a2 = await runProbe(['run', '--agent', 'mypl-build', 'say hi']);
  check(
    'A2 hidden role rejected from primary resolution',
    a2.kind === 'SUBAGENT_REJECT',
    `${a2.kind} ${a2.ms}ms`,
  );

  // A3 — contrast baseline for A1's silence.
  const a3 = await runProbe(['run', '--agent', 'nosuch-zz-9', 'say hi']);
  check(
    'A3 unknown name answers not-found (baseline)',
    a3.kind === 'NOT_FOUND',
    `${a3.kind} ${a3.ms}ms`,
  );

  // A5 — a hidden role as default_agent never binds the session. Observed
  // at this pin: the run ERRORS out before any header (the C-R1d defaultInfo
  // throw family) or silently falls back to a visible primary; both satisfy
  // the invariant — what must NEVER happen is `> mypl-build` binding.
  const t = readTree(configPath);
  t.default_agent = 'mypl-build';
  writeFileSync(configPath, JSON.stringify(t, null, 2));
  const a5 = await runProbe(['run', 'say hi']);
  const h5 = a5.text.match(HEADER);
  const a5Bound = h5 ? h5[1] : null;
  check(
    'A5 hidden-role default_agent never binds',
    a5Bound !== 'mypl-build',
    `kind=${a5.kind} bound=${a5Bound ?? 'nothing'} — ${
      a5Bound === null
        ? 'run refused the hidden-role default before binding (C-R1d throw family)'
        : `silent fallback to ${a5Bound}`
    }; dashboard AP-7 gate stays the write-side authority`,
  );
} catch (err) {
  failed = true;
  console.error(`harness 5.3 ERROR: ${err && err.message ? err.message : err}`);
} finally {
  try {
    reportProof(before, liveProof());
  } catch (err) {
    console.error(String(err.message ?? err));
    failed = true;
  }
  cleanup(base);
}
console.log(failed ? 'HARNESS 5.3: FAIL' : 'HARNESS 5.3: PASS');
process.exit(failed ? 1 : 0);
