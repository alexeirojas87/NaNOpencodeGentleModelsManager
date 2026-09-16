// phase-agents-v3 task 1.2/1.3 (RED) — version resolution chain (spec
// area version-detection, design Decision 4): state.json first, spawn
// fallback second, conservative degradation last — typed, never thrown.
// Hermetic by injection: resolveVersionWith takes statePath/binary/spawn
// directly; the env-driven resolveVersion tests use sandbox fixtures and a
// stub binary — a real gentle-ai binary is NEVER spawned (task 1.1 rule).
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  resolveVersion,
  resolveVersionWith,
  VERSION_OUTPUT_CAP_BYTES,
  VERSION_TIMEOUT_MS,
  type GentleAiVersion,
  type SpawnFn,
} from '../../../server/src/config/version';

const sandbox = mkdtempSync(join(tmpdir(), 'mdash-version-unit-'));

afterEach(() => {
  vi.unstubAllEnvs();
});

function stateFile(content: string): string {
  const p = join(sandbox, `state-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, content);
  return p;
}

/** Spawn spy that never gets called when the state file answers. */
function spawnSpy(output = '3.0.0'): SpawnFn & { calls: number } {
  const fn = Object.assign(
    vi.fn(async () => ({ stdout: output, stderr: '' })),
    { calls: 0 },
  );
  return fn as unknown as SpawnFn & { calls: number };
}

/** Spawn spy rejecting with a Node execFile-shaped error. */
function spawnFailing(err: {
  code?: string | number | null;
  killed?: boolean;
  signal?: string | null;
  message?: string;
}): SpawnFn {
  const error = new Error(err.message ?? 'spawn failed') as Error & {
    code?: unknown;
    killed?: boolean;
    signal?: unknown;
  };
  if (err.code !== undefined) error.code = err.code;
  if (err.killed !== undefined) error.killed = err.killed;
  if (err.signal !== undefined) error.signal = err.signal;
  return vi.fn(async () => {
    throw error;
  }) as unknown as SpawnFn;
}

describe('resolveVersionWith — state file stage (map rows 1–2)', () => {
  it('state file with installed_binary_version 3.0.0 → 3.x state_file; NO spawn', async () => {
    const spawn = spawnSpy();
    const v = await resolveVersionWith({
      statePath: stateFile(
        JSON.stringify({ installed_binary_version: '3.0.0' }),
      ),
      binary: 'gentle-ai',
      spawn,
    });
    expect(v).toEqual({
      version: '3.0.0',
      mode: '3.x',
      source: 'state_file',
    });
    expect(spawn).not.toHaveBeenCalled(); // scenario: no spawn occurs
  });

  it('state file versions map: 2.5.0 → 2.x, 3.9.9 → 3.x, 1.0.0 → 2.x', async () => {
    const spawn = spawnSpy();
    for (const [raw, mode] of [
      ['2.5.0', '2.x'],
      ['3.9.9', '3.x'],
      ['1.0.0', '2.x'],
    ] as const) {
      const v = await resolveVersionWith({
        statePath: stateFile(JSON.stringify({ installed_binary_version: raw })),
        binary: 'gentle-ai',
        spawn,
      });
      expect(v.mode, raw).toBe(mode);
      expect(v.source, raw).toBe('state_file');
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it('state file WITHOUT the key → spawn fallback parses the version (scenario)', async () => {
    const spawn = spawnSpy('2.5.4');
    const v = await resolveVersionWith({
      statePath: stateFile(JSON.stringify({ something: 'else' })),
      binary: 'gentle-ai',
      spawn,
    });
    expect(v).toEqual({
      version: '2.5.4',
      mode: '2.x',
      source: 'binary_probe',
    });
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe('resolveVersionWith — spawn fallback stage (map row 3)', () => {
  it('corrupt state JSON → spawn fallback → binary_probe', async () => {
    const spawn = spawnSpy('3.1.0');
    const v = await resolveVersionWith({
      statePath: stateFile('{corrupt json!!'),
      binary: 'gentle-ai',
      spawn,
    });
    expect(v).toEqual({
      version: '3.1.0',
      mode: '3.x',
      source: 'binary_probe',
    });
  });

  it('absent state file → spawn fallback → binary_probe', async () => {
    const spawn = spawnSpy('3.0.2');
    const v = await resolveVersionWith({
      statePath: join(sandbox, 'never-written.json'),
      binary: 'gentle-ai',
      spawn,
    });
    expect(v).toEqual({
      version: '3.0.2',
      mode: '3.x',
      source: 'binary_probe',
    });
  });

  it('spawn probes the configured binary with --version, argv array, caps and closed stdin', async () => {
    const spawn = spawnSpy('2.5.4');
    await resolveVersionWith({
      statePath: join(sandbox, 'never-written-2.json'),
      binary: '/opt/stub/gentle-ai',
      spawn,
    });
    expect(spawn).toHaveBeenCalledWith('/opt/stub/gentle-ai', ['--version'], {
      timeout: VERSION_TIMEOUT_MS,
      maxBuffer: VERSION_OUTPUT_CAP_BYTES,
    });
    expect(VERSION_TIMEOUT_MS).toBe(10_000);
    expect(VERSION_OUTPUT_CAP_BYTES).toBe(1024 * 1024);
  });
});

describe('resolveVersionWith — conservative degradation (map row 4)', () => {
  const CONSERVATIVE: GentleAiVersion = {
    version: null,
    mode: 'unknown',
    source: 'conservative_fallback',
  };

  it('ENOENT spawn → conservative + spawn_not_found; NEVER throws', async () => {
    const v = await resolveVersionWith({
      statePath: join(sandbox, 'absent-3.json'),
      binary: 'gentle-ai',
      spawn: spawnFailing({
        code: 'ENOENT',
        message: 'spawn gentle-ai ENOENT',
      }),
    });
    expect(v).toEqual({
      ...CONSERVATIVE,
      detail: expect.stringContaining('spawn_not_found'),
    });
    expect(v.detail).toContain('ENOENT');
  });

  it('timed-out spawn (killed/SIGTERM) → conservative + spawn_timeout', async () => {
    const v = await resolveVersionWith({
      statePath: join(sandbox, 'absent-4.json'),
      binary: 'gentle-ai',
      spawn: spawnFailing({ killed: true, signal: 'SIGTERM', code: null }),
    });
    expect(v.mode).toBe('unknown');
    expect(v.source).toBe('conservative_fallback');
    expect(v.detail).toContain('spawn_timeout');
  });

  it('maxBuffer flood → conservative + spawn_output_limit', async () => {
    const v = await resolveVersionWith({
      statePath: join(sandbox, 'absent-5.json'),
      binary: 'gentle-ai',
      spawn: spawnFailing({ code: 'ENOBUFS' }),
    });
    expect(v.detail).toContain('spawn_output_limit');
  });

  it('non-zero exit → conservative + spawn_failed', async () => {
    const v = await resolveVersionWith({
      statePath: join(sandbox, 'absent-6.json'),
      binary: 'gentle-ai',
      spawn: spawnFailing({ code: 1, message: 'Command failed' }),
    });
    expect(v.detail).toContain('spawn_failed');
  });

  it('unparseable stdout → conservative + unparseable', async () => {
    const spawn = spawnSpy('gentle-ai version ???');
    const v = await resolveVersionWith({
      statePath: join(sandbox, 'absent-7.json'),
      binary: 'gentle-ai',
      spawn,
    });
    expect(v).toEqual({
      version: null,
      mode: 'unknown',
      source: 'conservative_fallback',
      detail: expect.stringContaining('unparseable'),
    });
  });

  it('unreadable/corrupt state AND failed spawn → detail names BOTH stages', async () => {
    const v = await resolveVersionWith({
      statePath: stateFile('{corrupt!!'),
      binary: 'gentle-ai',
      spawn: spawnFailing({ code: 'ENOENT' }),
    });
    expect(v.source).toBe('conservative_fallback');
    expect(v.detail).toContain('state_unreadable');
    expect(v.detail).toContain('spawn_not_found');
  });

  it('absent state AND failed spawn → detail names only the spawn stage', async () => {
    const v = await resolveVersionWith({
      statePath: join(sandbox, 'absent-8.json'),
      binary: 'gentle-ai',
      spawn: spawnFailing({ code: 'ENOENT' }),
    });
    expect(v.detail).not.toContain('state_unreadable');
  });
});

describe('resolveVersion — env-driven, memoized per (statePath, binary)', () => {
  it('spawn fallback runs EXACTLY ONCE across two resolve calls (per-key memo)', async () => {
    // State file exists but lacks the key → spawn is the answering stage.
    const statePath = stateFile(JSON.stringify({ fresh: true }));
    const counter = join(sandbox, 'spawn-count.txt');
    const bin = join(sandbox, 'counting-gentle-ai.sh');
    writeFileSync(
      bin,
      `#!/bin/sh\nprintf 'run\\n' >> "$STATE_COUNT_FILE"\nprintf '3.1.0'\n`,
    );
    chmodSync(bin, 0o755);
    vi.stubEnv('GENTLE_AI_STATE_PATH', statePath);
    vi.stubEnv('GENTLE_AI_BIN', bin);
    vi.stubEnv('STATE_COUNT_FILE', counter);

    const first = await resolveVersion();
    const second = await resolveVersion();
    expect(first).toEqual(second);
    expect(first).toEqual({
      version: '3.1.0',
      mode: '3.x',
      source: 'binary_probe',
    });
    // Two resolves, ONE child process — the memo covers the process lifetime.
    expect(readFileSync(counter, 'utf8').split('\n').filter(Boolean)).toEqual([
      'run',
    ]);
  });

  it('a changed (statePath, binary) env pair resolves FRESH (no stale cross-key cache)', async () => {
    const oldState = stateFile(
      JSON.stringify({ installed_binary_version: '2.5.0' }),
    );
    const newState = stateFile(
      JSON.stringify({ installed_binary_version: '3.0.0' }),
    );
    const bin = join(sandbox, 'no-spawn-needed.sh');
    writeFileSync(bin, '#!/bin/sh\nprintf "should-never-run"\n');
    chmodSync(bin, 0o755);
    vi.stubEnv('GENTLE_AI_BIN', bin);

    vi.stubEnv('GENTLE_AI_STATE_PATH', oldState);
    const before = await resolveVersion();
    expect(before).toEqual({
      version: '2.5.0',
      mode: '2.x',
      source: 'state_file',
    });

    vi.stubEnv('GENTLE_AI_STATE_PATH', newState);
    const after = await resolveVersion();
    expect(after).toEqual({
      version: '3.0.0',
      mode: '3.x',
      source: 'state_file',
    });
  });
});

// --- real subprocess boundary (runtime proof for the flood guard) ----------
describe('resolveVersionWith — real execFile boundary', () => {
  it('a real stub flooding stdout beyond maxBuffer → spawn_output_limit', async () => {
    const bin = join(sandbox, 'flood-gentle-ai.sh');
    // 2MB on stdout — twice the 1MB cap.
    writeFileSync(bin, `#!/bin/sh\nperl -e 'print "x" x (1024*1024*2)'\n`);
    chmodSync(bin, 0o755);
    const v = await resolveVersionWith({
      statePath: join(sandbox, 'absent-9.json'),
      binary: bin,
    });
    expect(v.version).toBeNull();
    expect(v.mode).toBe('unknown');
    expect(v.source).toBe('conservative_fallback');
    expect(v.detail).toContain('spawn_output_limit');
  }, 20_000);
});
