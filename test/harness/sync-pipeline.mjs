#!/usr/bin/env node
// agent-pipelines WU-5 task 5.1 — AP-8 SYNC-STABILITY golden (sandbox level,
// not vitest): create a pipeline through the REAL API under a mkdtemp HOME →
// run the REAL `gentle-ai` sync → assert the definition key and every
// materialized row survive byte-identically (value identity per subtree —
// see _support.canon for why Go's key-sorting re-serialization makes the
// canonical form the honest byte-golden; deny-star-first is asserted to
// survive the re-sort).
//
// Run:  node test/harness/sync-pipeline.mjs
// Skip-if-missing-binary (WU-B 2.0 pattern): exits 0 with a SKIP line.
// The live ~/.config is never resolved: HOME + CONFIG_PATH both sandboxed,
// with a before/after content proof of the real file.
import { spawnSync } from 'node:child_process';
import {
  baseTree,
  canonSha,
  cleanup,
  createPipelineViaApi,
  ensureTsxChild,
  installSandboxHome,
  liveProof,
  mkSandbox,
  readTree,
  reportProof,
  skipOr,
  versionLine,
  writeConfig,
} from './_support.mjs';

ensureTsxChild(import.meta.url);

const GENTLE_AI = process.env.GENTLE_AI_BIN || 'gentle-ai';
const version = versionLine(GENTLE_AI);
skipOr(
  version !== null,
  GENTLE_AI,
  'the sync-stability golden needs the real CLI',
);
console.log(`harness 5.1 sync-pipeline — ${version}`);

const before = liveProof();
const base = mkSandbox('mdash-harness-sync-');
let failed = false;
try {
  const home = installSandboxHome(base);
  const configPath = writeConfig(home, baseTree());
  await createPipelineViaApi(configPath, base);

  const tree = readTree(configPath);
  const targets = [
    ['definition agent-pipelines.mypl', tree['agent-pipelines'].mypl],
    ['row agent.mypl (orchestrator)', tree.agent.mypl],
    ['row agent.mypl-build', tree.agent['mypl-build']],
    ['row agent.mypl-review', tree.agent['mypl-review']],
  ];
  const golden = Object.fromEntries(
    targets.map(([label, value]) => [label, canonSha(value)]),
  );
  // Security-bearing order, pre-sync: deny-star first under C-R1f.
  const taskKeys0 = Object.keys(tree.agent.mypl.permission.task);
  if (taskKeys0[0] !== '*')
    throw new Error(`task map lost deny-star first: ${taskKeys0}`);

  console.log('running real gentle-ai sync under sandbox HOME…');
  const sync = spawnSync(GENTLE_AI, ['sync'], {
    env: { ...process.env, HOME: home },
    cwd: home,
    encoding: 'utf8',
    timeout: 180_000,
  });
  if (sync.error) throw sync.error;
  console.log(
    `sync exit=${sync.status} (${(sync.stdout || '').split('\n').find((l) => /Managed sync|synced/i.test(l)) ?? 'no summary line'})`,
  );
  if (sync.status !== 0) {
    console.log(sync.stdout);
    console.log(sync.stderr);
    throw new Error('gentle-ai sync exited non-zero');
  }

  const post = readTree(configPath);
  const postTargets = {
    'definition agent-pipelines.mypl': post['agent-pipelines'].mypl,
    'row agent.mypl (orchestrator)': post.agent.mypl,
    'row agent.mypl-build': post.agent['mypl-build'],
    'row agent.mypl-review': post.agent['mypl-review'],
  };
  for (const [label, value] of Object.entries(postTargets)) {
    const sha = canonSha(value);
    const ok = sha === golden[label];
    console.log(
      `  ${ok ? 'byte-identical' : 'CHANGED'}: ${label} ${sha.slice(0, 12)}`,
    );
    if (!ok) failed = true;
  }
  const taskKeys = Object.keys(post.agent.mypl.permission.task);
  const orderOk = taskKeys[0] === '*';
  console.log(
    `  ${orderOk ? 'order-held' : 'ORDER BROKEN'}: task map first key = ${JSON.stringify(taskKeys[0])} (Go sort keeps '*' < any name char)`,
  );
  if (!orderOk) failed = true;
  // The sync did real work (reserved agents landed) — the golden is not vacuous.
  console.log(
    `  sanity: post-sync agent count ${Object.keys(post.agent).length} (pipeline rows all present: ${['mypl', 'mypl-build', 'mypl-review'].every((n) => n in post.agent)})`,
  );
  if (!['mypl', 'mypl-build', 'mypl-review'].every((n) => n in post.agent))
    failed = true;
} catch (err) {
  failed = true;
  console.error(`harness 5.1 ERROR: ${err && err.message ? err.message : err}`);
} finally {
  try {
    reportProof(before, liveProof());
  } catch (err) {
    console.error(String(err.message ?? err));
    failed = true;
  }
  cleanup(base);
}
console.log(failed ? 'HARNESS 5.1: FAIL' : 'HARNESS 5.1: PASS');
process.exit(failed ? 1 : 0);
