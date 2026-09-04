// WU9.1 (RED) — HTTP-level subprocess threat tests + the OA-3 sync contract
// for POST /api/sync (design §API-Surface: `{args?}` allowlisted →
// `{exitCode, stdout, stderr}`, reload after). Driven via app.request():
// no real port listening (WU5 pattern), the child binary is a STUB via
// GENTLE_AI_BIN so no test ever runs the installed gentle-ai, and CONFIG
// is a sandboxed fixture copy — the live ~/.config/opencode/opencode.json
// is never resolved, opened or written here.
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { app } from '../../server/src/app';
import type { ConfigTree } from '../../server/src/config/load';
import type { ConfigResponse, SyncResponse } from '../../shared/types';

const FIXTURE_PATH = fileURLToPath(
  new URL('../fixtures/config.sample.json', import.meta.url),
);
const SECRET = 'sk-synthetic-nan-placeholder-do-not-use';

const sha256 = (s: string): string =>
  createHash('sha256').update(s, 'utf8').digest('hex');

// --- sandbox bookkeeping (mirrors the WU5 integration harness) -------------
const tempDirs: string[] = [];
let sandbox: string;
let prevConfigEnv: string | undefined;
let prevAuthEnv: string | undefined;
let prevBinEnv: string | undefined;

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'mdash-sync-routes-'));
  prevConfigEnv = process.env.CONFIG_PATH;
  prevAuthEnv = process.env.AUTH_PATH;
  prevBinEnv = process.env.GENTLE_AI_BIN;
  copyFileSync(FIXTURE_PATH, join(sandbox, 'safety-opencode.json'));
  process.env.CONFIG_PATH = join(sandbox, 'safety-opencode.json');
  process.env.AUTH_PATH = join(sandbox, 'absent-auth.json');
});
afterAll(() => {
  for (const [key, value] of [
    ['CONFIG_PATH', prevConfigEnv],
    ['AUTH_PATH', prevAuthEnv],
    ['GENTLE_AI_BIN', prevBinEnv],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(sandbox, { recursive: true, force: true });
});
afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

function sandboxConfig(): string {
  const dir = mkdtempSync(join(sandbox, 'case-'));
  tempDirs.push(dir);
  const configPath = join(dir, 'opencode.json');
  copyFileSync(FIXTURE_PATH, configPath);
  process.env.CONFIG_PATH = configPath;
  return configPath;
}

interface StubCase {
  dump?: string;
  stdout?: string;
  stderr?: string;
  rewriteConfig?: { path: string; content: string };
  exit?: number;
}

/** Executable fake gentle-ai (same shape as the WU9 unit tests). */
function stub(caseCfg: StubCase): string {
  const path = join(
    sandbox,
    `route-stub-${tempDirs.length}-${Math.random().toString(36).slice(2)}.cjs`,
  );
  const src = `#!/usr/bin/env node
const fs = require('node:fs');
const CASE = ${JSON.stringify(caseCfg)};
if (CASE.dump) fs.writeFileSync(CASE.dump, JSON.stringify({ argv: process.argv.slice(2) }));
if (CASE.stdout) process.stdout.write(CASE.stdout);
if (CASE.stderr) process.stderr.write(CASE.stderr);
if (CASE.rewriteConfig) fs.writeFileSync(CASE.rewriteConfig.path, CASE.rewriteConfig.content);
process.exit(CASE.exit ?? 0);
`;
  writeFileSync(path, src, 'utf8');
  chmodSync(path, 0o755);
  return path;
}

async function postSync(body: unknown): Promise<Response> {
  return app.request('/api/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
const jsonOf = async <T>(res: Response): Promise<T> => (await res.json()) as T;

describe('POST /api/sync — threat #1/#2: argv injection is stopped before any spawn', () => {
  it('metachar in an allowlisted flag value → 400 sync_bad_args, the binary never runs', async () => {
    const dump = join(sandbox, 'never-written-metachar.json');
    const marker = join(sandbox, 'PWNED-metachar');
    process.env.GENTLE_AI_BIN = stub({ dump });
    const res = await postSync({
      args: ['--profile', `sdd-spec:nan/qwen3.8-flash;touch ${marker}`],
    });
    expect(res.status).toBe(400);
    const body = await jsonOf<{
      ok: boolean;
      error?: { code: string; argIndex?: number };
    }>(res);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('sync_bad_args');
    expect(body.error?.argIndex).toBe(1);
    // Never spawned, never interpreted.
    expect(existsSync(dump)).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  it('unknown flags and malformed bodies → 400 with the allowlist named in the message', async () => {
    const dump = join(sandbox, 'never-written-unknown.json');
    process.env.GENTLE_AI_BIN = stub({ dump });
    for (const body of [
      { args: ['--dry-run'] }, // a REAL gentle-ai flag, deliberately off-allowlist
      { args: ['inject-me'] },
      { args: { not: 'an array' } },
      { args: ['--profile', 42] },
    ]) {
      const res = await postSync(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      const payload = await jsonOf<{ error?: { code: string } }>(res);
      expect(payload.error?.code).toMatch(/sync_bad_args|bad_request/);
    }
    expect(existsSync(dump)).toBe(false);
  });
});

describe('POST /api/sync — OA-3 success: pass-through run, output + reload', () => {
  it('exit 0 surfaces stdout/exit code, carries the reloaded hash, and GET /api/config reflects post-sync CONFIG', async () => {
    const configPath = sandboxConfig();
    const dump = join(sandbox, 'argv-sync-ok.json');
    // The stub plays gentle-ai sync: it appends a marker-updated agent to
    // CONFIG (an external write, exactly what sync does to the prompt table).
    const tree = JSON.parse(readFileSync(configPath, 'utf8')) as ConfigTree;
    const agent = (tree.agent ??= {});
    agent['post-sync-agent'] = { model: 'nan/qwen3.6' };
    process.env.GENTLE_AI_BIN = stub({
      dump,
      stdout: 'gentle-ai sync: prompt table refreshed\n',
      rewriteConfig: {
        path: configPath,
        content: JSON.stringify(tree, null, 2),
      },
    });

    const res = await postSync({});
    expect(res.status).toBe(200);
    const body = await jsonOf<SyncResponse>(res);
    expect(body.ok).toBe(true);
    expect(body.exitCode).toBe(0);
    expect(body.stdout).toContain('prompt table refreshed');
    // "reload after": the response hash is the POST-sync file, not a cached one.
    expect(body.hash).toBe(sha256(readFileSync(configPath, 'utf8')));
    // Bare body ran the fixed command unchanged: gentle-ai sync, invoked once.
    expect(
      (JSON.parse(readFileSync(dump, 'utf8')) as { argv: string[] }).argv,
    ).toEqual(['sync']);

    const config = await jsonOf<ConfigResponse>(
      await app.request('/api/config'),
    );
    expect(config.hash).toBe(body.hash);
    // The assignments list the matrix consumes now shows sync's work (OA-3).
    expect(config.agents['post-sync-agent']?.model).toBe('nan/qwen3.6');
    // CX-2 still holds on the post-sync read: values masked, never leaked.
    expect(JSON.stringify(config)).not.toContain(SECRET);
  });
});

describe('POST /api/sync — OA-3 failure: exit code passes through, no success state', () => {
  it('non-zero exit → same 200 outcome shape carrying the failure code, no reload hash, CONFIG untouched', async () => {
    const configPath = sandboxConfig();
    const before = readFileSync(configPath, 'utf8');
    const dump = join(sandbox, 'argv-sync-fail.json');
    process.env.GENTLE_AI_BIN = stub({
      dump,
      stdout: 'gentle-ai sync: starting\n',
      stderr: 'gentle-ai sync: profile store locked\n',
      exit: 3,
    });

    const res = await postSync({
      args: ['--sdd-profile-strategy', 'external-single-active'],
    });
    expect(res.status).toBe(200);
    const body = await jsonOf<SyncResponse>(res);
    // Output and the failure code surface — that IS the pass-through.
    expect(body.exitCode).toBe(3);
    expect(body.stdout).toContain('starting');
    expect(body.stderr).toContain('locked');
    // No success state: no reloaded hash, no CONFIG change, argv literal.
    expect('hash' in body).toBe(false);
    expect(readFileSync(configPath, 'utf8')).toBe(before);
    expect(
      (JSON.parse(readFileSync(dump, 'utf8')) as { argv: string[] }).argv,
    ).toEqual(['sync', '--sdd-profile-strategy', 'external-single-active']);
  });

  it('a missing binary surfaces the typed sync_spawn envelope, not a crash', async () => {
    const configPath = sandboxConfig();
    const before = readFileSync(configPath, 'utf8');
    process.env.GENTLE_AI_BIN = join(sandbox, 'no-such-gentle-ai');
    const res = await postSync({});
    expect(res.status).toBe(500);
    const body = await jsonOf<{ error?: { code: string } }>(res);
    expect(body.error?.code).toBe('sync_spawn');
    expect(readFileSync(configPath, 'utf8')).toBe(before);
  });
});
