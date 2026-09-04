// WU2.1 (RED) — config load contract (PC-1, SCW-1 inputs, sandbox rule).
// Sandbox: every fs-touching case operates on a temp-dir copy of the
// synthetic fixture via an explicit path or CONFIG_PATH. The real
// ~/.config/opencode/opencode.json is NEVER read or written here.
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  ConfigLoadError,
  load,
  resolveConfigPath,
} from '../../../server/src/config/load';

const FIXTURE_PATH = fileURLToPath(
  new URL('../../fixtures/config.sample.json', import.meta.url),
);

/** Copy the fixture into a fresh temp dir; return the copy's path. */
function tempConfigCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mdash-load-'));
  const configPath = join(dir, 'opencode.json');
  copyFileSync(FIXTURE_PATH, configPath);
  return configPath;
}

async function expectLoadError(
  promise: Promise<unknown>,
): Promise<ConfigLoadError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ConfigLoadError);
  return err as ConfigLoadError;
}

describe('load() — success shape (PC-1)', () => {
  it('returns raw, tree, sha256 hash and mtime for an existing config', async () => {
    const configPath = tempConfigCopy();
    const raw = readFileSync(configPath, 'utf8');

    const loaded = await load(configPath);

    expect(loaded.path).toBe(configPath);
    expect(loaded.raw).toBe(raw);
    expect(loaded.tree).toEqual(JSON.parse(raw));
    expect(loaded.hash).toBe(
      createHash('sha256').update(raw, 'utf8').digest('hex'),
    );
    expect(loaded.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.mtime).toBeInstanceOf(Date);
    expect(loaded.mtimeMs).toBe(loaded.mtime.getTime());
  });

  it('resolves an explicit path argument over CONFIG_PATH', async () => {
    const explicit = tempConfigCopy();
    const viaEnv = tempConfigCopy();
    const prev = process.env.CONFIG_PATH;
    process.env.CONFIG_PATH = viaEnv;
    try {
      expect((await load(explicit)).path).toBe(explicit);
      expect((await load()).path).toBe(viaEnv);
    } finally {
      if (prev === undefined) delete process.env.CONFIG_PATH;
      else process.env.CONFIG_PATH = prev;
    }
  });
});

describe('load() — hash ↔ bytes invariant (SCW-1 stale detection)', () => {
  it('hash changes iff bytes change: reorder/hash-stable and touch/hash-same', async () => {
    const configPath = tempConfigCopy();
    const before = await load(configPath);

    // Rewrite identical bytes → same hash.
    writeFileSync(configPath, before.raw);
    expect((await load(configPath)).hash).toBe(before.hash);

    // Change one byte-sequence of content → different hash.
    const edited = before.raw.replace(
      '"contextWindow": 1000000',
      '"contextWindow": 1000001',
    );
    writeFileSync(configPath, edited);
    const afterEdit = await load(configPath);
    expect(afterEdit.hash).not.toBe(before.hash);

    // Touch mtime with identical bytes → hash stable, mtime moved.
    utimesSync(configPath, new Date(0), new Date(Date.now() + 60_000));
    const touched = await load(configPath);
    expect(touched.hash).toBe(afterEdit.hash);
    expect(touched.mtimeMs).not.toBe(afterEdit.mtimeMs);
  });
});

describe('load() — failure modes: error, never create or repair (PC-1)', () => {
  it('missing CONFIG fails with code "missing" and creates nothing on disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mdash-missing-'));
    const configPath = join(dir, 'nested', 'opencode.json');

    const err = await expectLoadError(load(configPath));

    expect(err.code).toBe('missing');
    expect(err.path).toBe(configPath);
    // The dashboard must never create or "repair" CONFIG.
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(join(dir, 'nested'))).toBe(false);
  });

  it('unparseable CONFIG fails with code "parse" and leaves bytes untouched', async () => {
    const configPath = tempConfigCopy();
    const broken = '{ "provider": [oops';
    writeFileSync(configPath, broken);

    const err = await expectLoadError(load(configPath));

    expect(err.code).toBe('parse');
    expect(err.path).toBe(configPath);
    expect(readFileSync(configPath, 'utf8')).toBe(broken);
  });

  it('valid JSON that is not a top-level object is rejected as "parse"', async () => {
    const cases = ['[1, 2, 3]', '"just a string"', 'null', 'true'];
    for (const body of cases) {
      const configPath = tempConfigCopy();
      writeFileSync(configPath, body);
      const err = await expectLoadError(load(configPath));
      expect(err.code, `body: ${body}`).toBe('parse');
    }
  });
});

describe('resolveConfigPath — sandbox entry point (never touches disk)', () => {
  it('prefers CONFIG_PATH when set', () => {
    expect(
      resolveConfigPath({ CONFIG_PATH: '/tmp/sandbox/opencode.json' }),
    ).toBe('/tmp/sandbox/opencode.json');
  });

  it('falls back to the OpenCode config path under HOME', () => {
    expect(resolveConfigPath({ HOME: '/fake/home' })).toBe(
      '/fake/home/.config/opencode/opencode.json',
    );
  });
});
