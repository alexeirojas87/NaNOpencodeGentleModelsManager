#!/usr/bin/env node
// agent-pipelines WU-5 task 5.2 — AP-1 loader-inert / parse-at-pin.
// Boot the installed opencode binary (pin family: opencode@dev; the running
// version is printed for the record) with a sandbox CONFIG carrying the
// `agent-pipelines` key + materialized rows and assert:
//   1. `opencode agent list` exits 0 — startup SUCCEEDS with the foreign key
//      present (the loader ignores it: C-R2 onExcessProperty pass-through);
//   2. an OpenCode-side config REWRITE (`opencode mcp add <probe> --url`)
//      preserves the `agent-pipelines` subtree byte-identically — unknown
//      keys survive the tool's own read-modify-write path (AP-1 scenario
//      "loader inert", the rewrite half of C-R2).
//
// Run:  node test/harness/opencode-boot-inert.mjs
// Skip-if-missing: exits 0 with a SKIP line when the binary is absent.
// HOME is sandboxed; the live ~/.config gets a before/after sha proof.
import { spawnSync } from 'node:child_process';
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
  sha256,
  skipOr,
  versionLine,
  writeConfig,
} from './_support.mjs';

// The API-create leg imports server TS — re-exec under tsx transparently.
ensureTsxChild(import.meta.url);

const OPENCODE = process.env.OPENCODE_BIN || 'opencode';
const version = versionLine(OPENCODE);
skipOr(
  version !== null,
  OPENCODE,
  'the parse-at-pin boot probe needs the binary',
);
console.log(`harness 5.2 opencode-boot-inert — ${version}`);

const before = liveProof();
const base = mkSandbox('mdash-harness-boot-');
let failed = false;
try {
  const home = installSandboxHome(base);
  // The rows land through the dashboard's OWN API (tsx child bootstrap):
  // identical bytes to a real create, zero hand-copied literals.
  const configPath = writeConfig(home, baseTree());
  // The rows land through the dashboard's OWN API: identical bytes to a
  // real create, zero hand-copied literals.
  await createPipelineViaApi(configPath, base);
  const pre = readTree(configPath);
  const defRaw = JSON.stringify(pre['agent-pipelines']);

  // 1) Boot-with-key (agent list validates the CONFIG and exits 0 iff the
  //    decode accepts the foreign key — the strictness was proven live when
  //    an invalid `compaction.reserved` hard-failed this same command).
  const boot = spawnSync(OPENCODE, ['agent', 'list'], {
    env: { ...process.env, HOME: home },
    cwd: home,
    encoding: 'utf8',
    timeout: 120_000,
  });
  const listsPipeline = /mypl\s*\(primary\)/.test(boot.stdout || '');
  const listsRoles = /mypl-build\s*\(subagent\)/.test(boot.stdout || '');
  console.log(
    `  boot agent-list: exit=${boot.status} orchestrator-visible=${listsPipeline} role-rows-decoded(subagent,mgmt-surface)=${listsRoles}`,
  );
  if (boot.status !== 0 || !listsPipeline) {
    console.log(String(boot.stderr || boot.stdout).slice(0, 400));
    throw new Error('startup with agent-pipelines did not succeed');
  }

  // 2) OpenCode's own rewrite must preserve the key (probe: mcp add --url).
  const add = spawnSync(
    OPENCODE,
    ['mcp', 'add', 'harness-probe', '--url', 'http://127.0.0.1:9/mcp'],
    {
      env: { ...process.env, HOME: home },
      cwd: home,
      encoding: 'utf8',
      timeout: 120_000,
      input: '\n\n',
    },
  );
  console.log(`  opencode mcp add probe: exit=${add.status}`);
  if (add.status !== 0) {
    console.log(String(add.stdout || add.stderr).slice(0, 400));
    throw new Error('mcp-add rewrite probe failed to run');
  }
  const post = readTree(configPath);
  const survived = JSON.stringify(post['agent-pipelines']) === defRaw;
  const probeLanded = 'harness-probe' in (post.mcp ?? {});
  console.log(
    `  rewrite: agent-pipelines preserved=${survived} (sha ${sha256(defRaw).slice(0, 12)}…) · opencode wrote its own key=${probeLanded}`,
  );
  if (!survived || !probeLanded) {
    throw new Error('OpenCode rewrite lost or never touched the config');
  }
} catch (err) {
  failed = true;
  console.error(`harness 5.2 ERROR: ${err && err.message ? err.message : err}`);
} finally {
  try {
    reportProof(before, liveProof());
  } catch (err) {
    console.error(String(err.message ?? err));
    failed = true;
  }
  cleanup(base);
}
console.log(failed ? 'HARNESS 5.2: FAIL' : 'HARNESS 5.2: PASS');
process.exit(failed ? 1 : 0);
