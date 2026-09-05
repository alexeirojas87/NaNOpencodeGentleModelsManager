// agent-pipelines WU-5 — shared harness support (NOT a vitest file: these
// harnesses run standalone under `node test/harness/<name>.mjs` and are
// intentionally outside the vitest glob). WU-B 2.0 / #396 pattern: everything
// filesystem-touching happens inside a mkdtemp HOME; real binaries may run,
// but ONLY against the sandbox — the live ~/.config is guarded by a
// sha256(+mtime) proof captured before and after every spawn.
//
// Each harness self-bootstraps through `pnpm exec tsx` (child flag
// SDD_TSX_CHILD) so the server app + shared generator can be imported
// directly — pipeline configs written here are created through the REAL
// API, not hand-copied literals (zero parity drift with the dashboard).
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..',
);
export const FIXTURE_PATH = join(REPO_ROOT, 'test/fixtures/config.sample.json');

export const sha256 = (s) =>
  createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * Canonical serialization: recursive key-SORTED stringify. `gentle-ai sync`
 * is a Go binary — its config rewrites re-encode objects with alphabetically
 * sorted keys (verified live: '*' still sorts before every [\\w.-] name, so
 * the deny-star-first order under C-R1f survives BY CONSTRUCTION). The AP-8
 * golden therefore pins VALUE identity per subtree, not parent-file byte
 * order; the raw order is reported informationally.
 */
export function canon(value) {
  if (Array.isArray(value)) return value.map(canon);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canon(value[key]);
    return out;
  }
  return value;
}
export const canonSha = (value) => sha256(JSON.stringify(canon(value)));

export function mkSandbox(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function installSandboxHome(baseDir) {
  const home = join(baseDir, 'home');
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
  return home;
}

/** The fixture tree with the one key the REAL loader rejects adjusted. */
export function baseTree() {
  const tree = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
  // Discovery (harness prototype, 2026-09-05): `opencode agent list`
  // validates CONFIG strictly — the fixture's `compaction.reserved` string
  // sentinel ("unknown key must survive" — valid for the DASHBOARD's
  // permissive generated schema) is NOT a valid upstream value and hard
  // fails the loader. Harness bases drop it; nothing else changes.
  delete tree.compaction;
  return tree;
}

export function writeConfig(home, tree) {
  const path = join(home, '.config', 'opencode', 'opencode.json');
  writeFileSync(path, JSON.stringify(tree, null, 2));
  return path;
}

export function readTree(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// --- live-config guard ------------------------------------------------------

/** sha256+mtime of the REAL user config (never opened for writes). */
export function liveProof() {
  const path = join(homedir(), '.config', 'opencode', 'opencode.json');
  try {
    return {
      path,
      sha: sha256(readFileSync(path, 'utf8')),
      mtime: statSync(path).mtimeMs,
    };
  } catch {
    return null; // no live config on this machine — nothing to guard
  }
}

export function reportProof(before, after) {
  if (!before) {
    console.log(
      'proof: no live ~/.config/opencode/opencode.json present — nothing to guard',
    );
    return;
  }
  if (!after || after.sha !== before.sha) {
    throw new Error(
      `LIVE CONFIG MUTATED — sha ${before.sha.slice(0, 12)} → ${after ? after.sha.slice(0, 12) : 'gone'}. Sandbox containment FAILED.`,
    );
  }
  console.log(
    `proof: live config sha unchanged (${before.sha.slice(0, 12)}…)` +
      (after.mtime !== before.mtime
        ? ` [mtime drifted ${before.mtime} → ${after.mtime} — content-identical; another writer on this machine, not the harness (HOME was sandboxed throughout)]`
        : ' + mtime unchanged'),
  );
}

// --- binaries ---------------------------------------------------------------

export function binEnv(name, envVar) {
  return process.env[envVar] || name;
}

export function versionLine(cmd, args = ['--version']) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 30_000 });
    if (r.error || r.status !== 0) return null;
    return (r.stdout || r.stderr || '').trim().split('\n')[0];
  } catch {
    return null;
  }
}

export function skipOr(available, binary, what) {
  if (available) return;
  console.log(
    `SKIP: ${binary} binary not available — ${what} cannot run (skip-if-missing pattern, WU-B 2.0).`,
  );
  process.exit(0);
}

// --- API-created pipeline (tsx child; the REAL materializer writes the rows) --

/**
 * Boot the in-process Hono app against `configPath` and create one pipeline
 * through POST /api/agent-pipelines — identical bytes the dashboard saves.
 */
export async function createPipelineViaApi(configPath, sandbox) {
  process.env.CONFIG_PATH = configPath;
  process.env.AUTH_PATH = join(sandbox, 'absent-auth.json');
  // Sibling-relative .ts specifier: resolves under the tsx child bootstrap.
  const { app } = await import('../../server/src/app.ts');
  const hash = sha256(readFileSync(configPath, 'utf8'));
  const role = (n) => ({
    name: n,
    description: `${n} role`,
    promptSource: 'template',
    prompt: `Do ${n} work.`,
  });
  const body = {
    hash,
    pipeline: {
      name: 'mypl',
      orchestrator: { description: 'coordinate mypl' },
      roles: [role('mypl-build'), role('mypl-review')],
      helpers: ['general'],
    },
  };
  const res = await app.request('/api/agent-pipelines', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await res.json();
  if (res.status !== 200) {
    throw new Error(
      `pipeline create failed: ${res.status} ${JSON.stringify(payload)}`,
    );
  }
  return payload.hash;
}

// --- spawn with decisive-line watch (fast, deterministic) ---------------------

/**
 * Spawn `cmd args…` under sandbox HOME, watching merged output for the first
 * pattern that matches; the child is killed the moment a decision is visible
 * (opencode's network phase takes ~60s; the header/warning lands in <1s).
 */
export function spawnWatch(cmd, args, home, patterns, timeoutMs = 90_000) {
  return new Promise((resolvePromise) => {
    const t0 = Date.now();
    const child = spawn(cmd, args, {
      env: { ...process.env, HOME: home },
      cwd: home,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let settled = false;
    const finish = (kind, extra = {}) => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      resolvePromise({
        kind,
        ms: Date.now() - t0,
        text: out.replace(/\u001b\[[0-9;]*m/g, ''),
        ...extra,
      });
    };
    const onData = (buf) => {
      out += String(buf);
      const clean = out.replace(/\u001b\[[0-9;]*m/g, '');
      for (const [name, re] of patterns) {
        if (re.test(clean)) return finish(name);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => finish('SPAWN_ERROR', { error: String(err) }));
    child.on('exit', (code) => finish('EXIT', { exitCode: code }));
    setTimeout(() => finish('WATCHDOG'), timeoutMs);
  });
}

export function cleanup(baseDir) {
  rmSync(baseDir, { recursive: true, force: true });
}

/**
 * Re-exec the harness under tsx (child flag-guard) so the shared TS modules
 * (server app, generators) import unmodified. Plain `node test/harness/X.mjs`
 * stays the documented run command.
 */
export function ensureTsxChild(importMetaUrl) {
  if (process.env.SDD_TSX_CHILD === '1') return;
  const r = spawnSync(
    'pnpm',
    ['exec', 'tsx', fileURLToPath(importMetaUrl), ...process.argv.slice(2)],
    {
      stdio: 'inherit',
      cwd: REPO_ROOT,
      env: { ...process.env, SDD_TSX_CHILD: '1' },
    },
  );
  process.exit(r.status ?? 1);
}
