// WU4.1 + WU4.2 (RED) — save pipeline (SCW-1 order, SCW-2 stale rejection,
// SCW-3 validate-before-backup, SCW-4 backup-first, SCW-5 atomic tmp+rename,
// SCW-6 golden no-op, OA-4 prompt/marker byte preservation, SCW-7 pipeline
// gate placement). Sandbox rule: every write lands in an mkdtemp copy seeded
// from the fixture, addressed via CONFIG_PATH or an explicit temp path; the
// real ~/.config/opencode/opencode.json is never opened by these tests.
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// fs/promises is partially mocked (rename spy) so the same-directory
// containment contract of SCW-5 can be observed directly.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

import {
  ConfigLoadError,
  load,
  type ConfigTree,
} from '../../../server/src/config/load';
import { PatchError, type PatchOp } from '../../../server/src/config/patch';
import { SaveError, save } from '../../../server/src/config/save';

const FIXTURE_PATH = fileURLToPath(
  new URL('../../fixtures/config.sample.json', import.meta.url),
);

/** Temp dirs created by this file — removed after each test (sandbox rule). */
const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

/** Fresh temp dir holding a copy of the fixture as opencode.json. */
function tempConfigCopy(): { dir: string; configPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mdash-save-'));
  tempDirs.push(dir);
  const configPath = join(dir, 'opencode.json');
  copyFileSync(FIXTURE_PATH, configPath);
  return { dir, configPath };
}

// Safety net for the sandbox rule: if any test ever forgets an explicit
// configPath, resolution lands on this throwaway copy (a visible stale/missing
// failure) instead of the live ~/.config/opencode/opencode.json.
let safetyDir: string;
let prevEnvConfig: string | undefined;
beforeAll(() => {
  safetyDir = mkdtempSync(join(tmpdir(), 'mdash-safety-'));
  prevEnvConfig = process.env.CONFIG_PATH;
  process.env.CONFIG_PATH = join(safetyDir, 'opencode.json');
});
afterAll(() => {
  if (prevEnvConfig === undefined) delete process.env.CONFIG_PATH;
  else process.env.CONFIG_PATH = prevEnvConfig;
  rmSync(safetyDir, { recursive: true, force: true });
});

const sha256 = (s: string): string =>
  createHash('sha256').update(s, 'utf8').digest('hex');

async function expectSaveError(promise: Promise<unknown>): Promise<SaveError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SaveError);
  return err as SaveError;
}

describe('save — golden no-op (task 4.1, SCW-6, acceptance criterion 1)', () => {
  it('no-op save via CONFIG_PATH leaves byte-identical config and key order', async () => {
    const { dir, configPath } = tempConfigCopy();
    const prev = process.env.CONFIG_PATH;
    process.env.CONFIG_PATH = configPath;
    try {
      const before = readFileSync(configPath, 'utf8');
      const loaded = await load();
      expect(loaded.path).toBe(configPath);

      const res = await save([], {
        hash: loaded.hash,
        mtimeMs: loaded.mtimeMs,
      });

      const after = readFileSync(configPath, 'utf8');
      // Byte-identity is the strongest form of SCW-6: identical bytes imply
      // identical content AND identical insertion order, with no trailing newline.
      expect(after).toBe(before);
      expect(res.hash).toBe(loaded.hash);
      expect(res.raw).toBe(before);
      // SCW-4: even a no-op successful save leaves an exact-byte backup.
      expect(readFileSync(res.backupPath, 'utf8')).toBe(before);
      // No tmp debris: only the config and the backup dir exist.
      expect(readdirSync(dir).sort()).toEqual([
        'model-dashboard-backups',
        'opencode.json',
      ]);
    } finally {
      if (prev === undefined) delete process.env.CONFIG_PATH;
      else process.env.CONFIG_PATH = prev;
    }
  });
});

describe('save — mutation semantics and result contract', () => {
  it('allowlisted edit changes exactly one line and echoes a usable new base', async () => {
    const { configPath } = tempConfigCopy();
    const loaded = await load(configPath);

    const res = await save(
      [{ path: ['provider', 'nan', 'name'], value: 'NaN Renamed' }],
      { hash: loaded.hash, mtimeMs: loaded.mtimeMs },
      { configPath },
    );

    const after = readFileSync(configPath, 'utf8');
    const expectedTree = JSON.parse(loaded.raw) as ConfigTree;
    (expectedTree.provider as Record<string, ConfigTree>).nan.name =
      'NaN Renamed';
    // Same serialization convention as the golden fixture: 2-space,
    // insertion order, NO trailing newline.
    expect(after).toBe(JSON.stringify(expectedTree, null, 2));
    expect(after.endsWith('\n')).toBe(false);

    const beforeLines = loaded.raw.split('\n');
    const afterLines = after.split('\n');
    expect(afterLines.length).toBe(beforeLines.length);
    const changed = beforeLines.filter((l, i) => l !== afterLines[i]);
    expect(changed.length).toBe(1);
    expect(changed[0]).toContain('"name": "NaN"');

    expect(res.hash).toBe(sha256(after));
    expect(res.mtimeMs).toBeGreaterThanOrEqual(loaded.mtimeMs);

    // Reload-and-reapply chain: the echoed post-save hash is a valid base.
    const res2 = await save(
      [{ path: ['agent', 'sdd-spec', 'model'], value: 'nan/mimo-v2.5' }],
      { hash: res.hash, mtimeMs: res.mtimeMs },
      { configPath },
    );
    expect(res2.raw).toBe(readFileSync(configPath, 'utf8'));
    expect(res2.hash).toBe(sha256(res2.raw));
  });
});

describe('save — stale detection (task 4.2, SCW-1/SCW-2)', () => {
  it('external edit rejects pre-backup, bytes untouched, edits reapplicable', async () => {
    const { dir, configPath } = tempConfigCopy();
    const loaded = await load(configPath);

    const external = loaded.raw.replace('"share": "manual"', '"share": "auto"');
    expect(external).not.toBe(loaded.raw);
    writeFileSync(configPath, external); // another writer touched CONFIG

    const ops: PatchOp[] = [
      { path: ['provider', 'headroom', 'name'], value: 'Headroom X' },
    ];
    const err = await expectSaveError(
      save(ops, { hash: loaded.hash, mtimeMs: loaded.mtimeMs }, { configPath }),
    );
    expect(err.code).toBe('stale');
    expect(err.expectedHash).toBe(loaded.hash);
    expect(err.actualHash).toBe(sha256(external));
    expect(err.issues).toEqual([]);
    // Non-destructive: config bytes are the external version, untouched.
    expect(readFileSync(configPath, 'utf8')).toBe(external);
    // Rejection happened before the backup stage.
    expect(existsSync(join(dir, 'model-dashboard-backups'))).toBe(false);

    // SCW-2: pending edits are NOT discarded — reload-and-reapply succeeds.
    const reloaded = await load(configPath);
    const res = await save(
      ops,
      { hash: reloaded.hash, mtimeMs: reloaded.mtimeMs },
      { configPath },
    );
    expect(readFileSync(configPath, 'utf8')).toContain('"Headroom X"');
    // Backup carried the current on-disk bytes at save time.
    expect(readFileSync(res.backupPath, 'utf8')).toBe(external);
  });

  it('mtime mismatch rejects; hash stays authoritative for fast edits', async () => {
    const { configPath } = tempConfigCopy();
    const loaded = await load(configPath);

    // Touch with identical bytes: mtime moves, hash does not.
    utimesSync(configPath, new Date(), new Date(Date.now() + 60_000));
    const touched = await expectSaveError(
      save([], { hash: loaded.hash, mtimeMs: loaded.mtimeMs }, { configPath }),
    );
    expect(touched.code).toBe('stale'); // SCW-1 checks mtime when echoed
    // Hash is the decisive signal: a hash-only expectation still passes.
    const uneventful = await save([], { hash: loaded.hash }, { configPath });
    expect(uneventful.hash).toBe(loaded.hash);

    // Fast edit hidden by an unchanged mtime: hash mismatch still rejects.
    const base = await load(configPath);
    writeFileSync(
      configPath,
      base.raw.replace('"share": "manual"', '"share": "live"'),
    );
    utimesSync(configPath, new Date(base.mtimeMs), new Date(base.mtimeMs));
    const sneaky = await load(configPath);
    expect(sneaky.mtimeMs).toBe(base.mtimeMs);
    expect(sneaky.hash).not.toBe(base.hash);
    const fast = await expectSaveError(
      save([], { hash: base.hash, mtimeMs: base.mtimeMs }, { configPath }),
    );
    expect(fast.code).toBe('stale');
  });
});

describe('save — validation gates disk writes (task 4.2, SCW-3)', () => {
  it('contextWindow "1M" rejects with the key path and zero backups', async () => {
    const { dir, configPath } = tempConfigCopy();
    const loaded = await load(configPath);
    const qwen = (
      (loaded.tree.provider as Record<string, ConfigTree>).nan.models as Record<
        string,
        ConfigTree
      >
    )['qwen3.8-flash'];

    const err = await expectSaveError(
      save(
        [
          {
            path: ['provider', 'nan', 'models', 'qwen3.8-flash'],
            value: { ...qwen, contextWindow: '1M' },
          },
        ],
        { hash: loaded.hash, mtimeMs: loaded.mtimeMs },
        { configPath },
      ),
    );

    expect(err.code).toBe('invalid');
    const hit = err.issues.find(
      (i) => i.path === 'provider.nan.models.qwen3.8-flash.contextWindow',
    );
    expect(hit).toBeDefined();
    expect(hit?.message.toLowerCase()).toContain('number');
    // Pre-backup rejection: no backup dir, no write, no tmp debris.
    expect(existsSync(join(dir, 'model-dashboard-backups'))).toBe(false);
    expect(readFileSync(configPath, 'utf8')).toBe(loaded.raw);
    expect(readdirSync(dir)).toEqual(['opencode.json']);
  });

  it('off-allowlist ops surface as PatchError before any backup or write (SCW-7)', async () => {
    const { dir, configPath } = tempConfigCopy();
    const loaded = await load(configPath);

    const err = await save(
      [{ path: ['mcp', 'example-server', 'enabled'], value: true }],
      { hash: loaded.hash },
      { configPath },
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PatchError);
    expect((err as PatchError).code).toBe('off_allowlist');
    expect(readFileSync(configPath, 'utf8')).toBe(loaded.raw);
    expect(existsSync(join(dir, 'model-dashboard-backups'))).toBe(false);
  });
});

describe('save — atomicity (task 4.2, SCW-5, threat file-write #2)', () => {
  it('finalizes through a same-dir hidden tmp rename and preserves mode', async () => {
    const { configPath } = tempConfigCopy();
    chmodSync(configPath, 0o600);
    const loaded = await load(configPath);
    const renameMock = vi.mocked((await import('node:fs/promises')).rename);
    renameMock.mockClear();

    await save(
      [{ path: ['provider', 'nan', 'npm'], value: '@example/npm' }],
      { hash: loaded.hash },
      { configPath },
    );

    const calls = renameMock.mock.calls.filter((c) => c[1] === configPath);
    expect(calls.length).toBe(1); // exactly one replacement step
    const tmpSrc = String(calls[0][0]);
    expect(dirname(tmpSrc)).toBe(dirname(configPath)); // same-dir containment
    expect(basename(tmpSrc)).toMatch(/^\.opencode\.json\./); // hidden temp
    expect(existsSync(tmpSrc)).toBe(false); // consumed by the rename
    // apiKey-bearing config must not come back world-readable (SCW-4 spirit).
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it('concurrent readers only ever see complete before/after bytes', async () => {
    const { configPath } = tempConfigCopy();
    const loaded = await load(configPath);
    let done = false;
    const reader = (async () => {
      const seen: string[] = [];
      while (!done) {
        seen.push(readFileSync(configPath, 'utf8'));
        await new Promise((r) => setImmediate(r));
      }
      return seen;
    })();

    const res = await save(
      [{ path: ['agent', 'sdd-spec', 'model'], value: 'nan/qwen3.6' }],
      { hash: loaded.hash },
      { configPath },
    );
    done = true;
    const seen = await reader;

    expect(seen.length).toBeGreaterThan(2); // reads truly interleaved
    for (const bytes of seen) {
      expect(() => JSON.parse(bytes)).not.toThrow(); // never truncated
      expect(bytes === loaded.raw || bytes === res.raw).toBe(true);
    }
    expect(readFileSync(configPath, 'utf8')).toBe(res.raw);
  });

  it('a failing backup aborts the save before CONFIG is replaced', async () => {
    const { dir, configPath } = tempConfigCopy();
    const blocker = join(dir, 'blocked-backups');
    writeFileSync(blocker, 'not a directory');
    const loaded = await load(configPath);

    const err = await save(
      [{ path: ['provider', 'nan', 'name'], value: 'X' }],
      { hash: loaded.hash },
      { configPath, backupDir: blocker },
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(readFileSync(configPath, 'utf8')).toBe(loaded.raw);
    expect(readFileSync(blocker, 'utf8')).toBe('not a directory');
  });
});

describe('save — prompts and markers survive (task 4.2, OA-4)', () => {
  it('allowlisted save leaves prompt bodies, gentle-ai markers and apiKey bytes unchanged', async () => {
    const { configPath } = tempConfigCopy();
    const seed = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as ConfigTree;
    const agents = seed.agent as Record<string, Record<string, unknown>>;
    const promptBody = [
      'Render the spec prompt.',
      '<gentle-ai:sdd-model-assignments>',
      'sdd-spec: nan/glm5.3-flash',
      '</gentle-ai:sdd-model-assignments>',
    ].join('\n');
    const markerValue = {
      generated_by: 'gentle-ai sync',
      marker: '<!-- gentle-ai:sdd-model-assignments -->',
    };
    agents['sdd-spec'].prompt = promptBody;
    agents['gentle-orchestrator']['gentle-ai:sdd-model-assignments'] =
      markerValue;
    writeFileSync(configPath, JSON.stringify(seed, null, 2));

    const loaded = await load(configPath);
    const res = await save(
      [{ path: ['agent', 'sdd-spec', 'model'], value: 'nan/qwen3.6' }],
      { hash: loaded.hash },
      { configPath },
    );
    const after = res.raw;
    const afterTree = JSON.parse(after) as ConfigTree;
    const afterAgents = afterTree.agent as Record<
      string,
      Record<string, unknown>
    >;

    // Read-only OA-4 regions survive as identical serialized lines.
    const readOnlyLines = (raw: string) =>
      raw.split('\n').filter((l) => /prompt|gentle-ai/.test(l));
    expect(readOnlyLines(after)).toEqual(readOnlyLines(loaded.raw));
    // ...and deep-equal when parsed.
    expect(afterAgents['sdd-spec'].prompt).toBe(promptBody);
    expect(
      afterAgents['gentle-orchestrator']['gentle-ai:sdd-model-assignments'],
    ).toEqual(markerValue);
    // apiKey pass-through (PC-3) and all externally owned sections intact.
    expect(after).toContain(
      '"apiKey": "sk-synthetic-nan-placeholder-do-not-use"',
    );
    for (const section of [
      '$schema',
      'compaction',
      'instructions',
      'mcp',
      'share',
      'custom',
    ]) {
      expect(afterTree[section]).toEqual(loaded.tree[section]);
    }
    // Only the allowlisted model line differs between versions.
    const changed = loaded.raw
      .split('\n')
      .filter((l, i) => l !== after.split('\n')[i]);
    expect(changed.length).toBe(1);
    expect(changed[0]).toContain('"model": "nan/glm5.3-flash"');
  });
});

describe('save — load errors stay load errors (PC-1 carried through)', () => {
  it('missing CONFIG rejects with ConfigLoadError and creates nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mdash-save-missing-'));
    tempDirs.push(dir);
    const configPath = join(dir, 'nested', 'opencode.json');

    const err = await save([], { hash: '0'.repeat(64) }, { configPath }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConfigLoadError);
    expect((err as ConfigLoadError).code).toBe('missing');
    expect(existsSync(join(dir, 'nested'))).toBe(false);
  });
});
