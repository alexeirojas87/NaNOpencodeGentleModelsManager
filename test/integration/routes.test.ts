// WU5.2 (RED) — integration tests for the REST API (design §API-Surface).
// Routes are exercised via app.request() directly: NO real port listening.
// Sandbox rule (hardened after the WU4 near-miss): CONFIG_PATH is pointed at
// an mkdtemp copy of the fixture in beforeAll and every test re-points it at
// its own fresh copy; the live ~/.config/opencode/opencode.json is NEVER
// resolved, opened or written by this file. AUTH_PATH gets the same treatment.
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { app } from '../../server/src/app';
import { nanSnapshot } from '../../server/src/catalog';
import { BACKUP_DIR_NAME } from '../../server/src/config/backup';
import type { ConfigTree } from '../../server/src/config/load';
import type { ConfigResponse } from '../../shared/types';

const FIXTURE_PATH = fileURLToPath(
  new URL('../fixtures/config.sample.json', import.meta.url),
);
const SECRET = 'sk-synthetic-nan-placeholder-do-not-use';

interface Envelope {
  ok: boolean;
  hash?: string;
  error?: {
    code: string;
    message: string;
    path?: string;
    opIndex?: number;
    expected?: string;
    actual?: string;
    issues?: { path: string; message: string }[];
  };
}

const sha256 = (s: string): string =>
  createHash('sha256').update(s, 'utf8').digest('hex');

// --- sandbox bookkeeping -------------------------------------------------
const tempDirs: string[] = [];
let sandbox: string;
let prevConfigEnv: string | undefined;
let prevAuthEnv: string | undefined;

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'mdash-routes-'));
  prevConfigEnv = process.env.CONFIG_PATH;
  prevAuthEnv = process.env.AUTH_PATH;
  // Safety net: even a forgotten per-test override lands inside the sandbox.
  copyFileSync(FIXTURE_PATH, join(sandbox, 'safety-opencode.json'));
  process.env.CONFIG_PATH = join(sandbox, 'safety-opencode.json');
  process.env.AUTH_PATH = join(sandbox, 'absent-auth.json');
});
afterAll(() => {
  if (prevConfigEnv === undefined) delete process.env.CONFIG_PATH;
  else process.env.CONFIG_PATH = prevConfigEnv;
  if (prevAuthEnv === undefined) delete process.env.AUTH_PATH;
  else process.env.AUTH_PATH = prevAuthEnv;
  rmSync(sandbox, { recursive: true, force: true });
});
afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

/** Fresh sandbox copy of the fixture, installed as the active CONFIG_PATH. */
function sandboxConfig(): string {
  const dir = mkdtempSync(join(sandbox, 'case-'));
  tempDirs.push(dir);
  const configPath = join(dir, 'opencode.json');
  copyFileSync(FIXTURE_PATH, configPath);
  process.env.CONFIG_PATH = configPath;
  return configPath;
}

// --- request/response helpers ---------------------------------------------
async function req(
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return await app.request(
    path,
    body === undefined
      ? { method }
      : {
          method,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
}
const get = (path: string) => req('GET', path);
const put = (path: string, body: unknown) => req('PUT', path, body);
const post = (path: string, body: unknown) => req('POST', path, body);
const del = (path: string, body: unknown) => req('DELETE', path, body);

const envelope = async (res: Response): Promise<Envelope> =>
  (await res.json()) as Envelope;
const treeOf = (p: string): ConfigTree =>
  JSON.parse(readFileSync(p, 'utf8')) as ConfigTree;
const hashOf = (p: string): string => sha256(readFileSync(p, 'utf8'));
const backupFiles = (caseDir: string): string[] => {
  try {
    return readdirSync(join(caseDir, BACKUP_DIR_NAME)).filter((n) =>
      /^opencode-.*\.json$/.test(n),
    );
  } catch {
    return [];
  }
};
/** Lines that appear/disappear between two serializations of the tree. */
function changedLines(before: string, after: string) {
  const b = new Set(before.split('\n'));
  const a = new Set(after.split('\n'));
  return {
    added: after.split('\n').filter((l) => !b.has(l)),
    removed: before.split('\n').filter((l) => !a.has(l)),
  };
}
const stripComma = (l: string): string => l.trim().replace(/,$/, '');
const without = (o: Record<string, unknown>, k: string) => {
  const c = { ...o };
  delete c[k];
  return c;
};
const modelsOf = (tree: ConfigTree, id: string): Record<string, unknown> => {
  const entry = tree.provider?.[id] as { models?: Record<string, unknown> };
  return entry?.models ?? {};
};

// --- GET /api/config -------------------------------------------------------
describe('GET /api/config — masked ConfigResponse shape (PC-2, CX-2, OA-1)', () => {
  it('echoes hash+mtime and exposes exactly the ConfigResponse fields', async () => {
    const configPath = sandboxConfig();
    const res = await get('/api/config');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ConfigResponse;
    expect(Object.keys(body).sort()).toEqual([
      'agents',
      'authJson',
      'defaultAgent',
      'hash',
      'mtime',
      'providers',
      'snapshotAsOf',
    ]);
    expect(body.hash).toBe(hashOf(configPath));
    expect(body.mtime).toBe(Math.trunc(statSync(configPath).mtimeMs));
    // WU7 shipped the bundle — the REAL asOf of the offline snapshot (CX-4).
    expect(body.snapshotAsOf).toBe(nanSnapshot.asOf);
    expect(body.defaultAgent).toBe('gentle-orchestrator');
  });

  it('masks apiKey values as {configured} presence, never the value (CX-2)', async () => {
    const configPath = sandboxConfig();
    const body = (await (await get('/api/config')).json()) as ConfigResponse;
    expect(Object.keys(body.providers)).toEqual(
      Object.keys(treeOf(configPath).provider ?? {}),
    );
    // set → true, empty string → false, absent → stays absent.
    expect(body.providers.nan.options?.apiKey).toEqual({ configured: true });
    expect(body.providers.nanSendvalu.options?.apiKey).toEqual({
      configured: false,
    });
    expect('apiKey' in (body.providers.headroom.options ?? {})).toBe(false);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(SECRET);
    // A value-shaped apiKey is impossible anywhere in the payload.
    expect(serialized).not.toContain('"apiKey":"');
  });

  it('projects EVERY agent.* entry generically — nothing hardcoded (OA-1)', async () => {
    const configPath = sandboxConfig();
    const tree = treeOf(configPath);
    const body = (await (await get('/api/config')).json()) as ConfigResponse;
    // Deep-equal against the loaded tree: proves a full pass-through, not a
    // curated subset — 0..N agents by content, whatever CONFIG holds.
    expect(body.agents).toEqual(tree.agent);
    expect(Object.keys(body.agents)).toEqual(Object.keys(tree.agent ?? {}));
    // The fixture's non-sdd names are present too (no name list in server code).
    expect(Object.keys(body.agents)).toContain('review-security');
    expect(body.agents['gentle-orchestrator'].model).toBe('nan/qwen3.8-flash');
    expect('model' in (body.agents['sdd-spec-cheap'] ?? {})).toBe(false);
  });

  it('authJson.exists[] is existence-only: top-level keys, zero values', async () => {
    const configPath = sandboxConfig();
    const authPath = join(configPath, '..', 'auth.json');
    writeFileSync(
      authPath,
      JSON.stringify({
        nan: { type: 'oauth', refresh: 'super-secret-token' },
        openai: { type: 'api' },
      }),
    );
    process.env.AUTH_PATH = authPath;
    try {
      const body = (await (await get('/api/config')).json()) as ConfigResponse;
      expect(body.authJson).toEqual({ exists: ['nan', 'openai'] });
      expect(JSON.stringify(body)).not.toContain('super-secret-token');
    } finally {
      process.env.AUTH_PATH = join(sandbox, 'absent-auth.json');
    }
  });
});

// --- GET /api/status -------------------------------------------------------
describe('GET /api/status — minimal fields per design §API-Surface', () => {
  it('reports config identity with the REAL advisory drift cells from the bundled snapshot (WU7)', async () => {
    const configPath = sandboxConfig();
    const res = await get('/api/status');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      path: configPath,
      hash: hashOf(configPath),
      mtime: Math.trunc(statSync(configPath).mtimeMs),
      // Golden: the fixture's nan provider matches the snapshot metadata, so
      // exactly its 5 differing contextWindow declarations surface, in
      // insertion order. Aligned qwen3.6 produces no cell; headroom and
      // nanSendvalu (non-matching metadata) produce nothing either.
      drift: [
        {
          provider: 'nan',
          model: 'glm5.3-flash',
          field: 'contextWindow',
          declared: 262144,
          snapshot: 1048576,
          advisory: true,
        },
        {
          provider: 'nan',
          model: 'qwen3.8-flash',
          field: 'contextWindow',
          declared: 1000000,
          snapshot: 262144,
          advisory: true,
        },
        {
          provider: 'nan',
          model: 'mimo-v2.5',
          field: 'contextWindow',
          declared: 262144,
          snapshot: 1048576,
          advisory: true,
        },
        {
          provider: 'nan',
          model: 'deepseek-v4-flash',
          field: 'contextWindow',
          declared: 163840,
          snapshot: 1048576,
          advisory: true,
        },
        {
          provider: 'nan',
          model: 'gemma4',
          field: 'contextWindow',
          declared: 131072,
          snapshot: 262144,
          advisory: true,
        },
      ],
      snapshotAsOf: nanSnapshot.asOf,
      backups: [],
      // No CONFIG write has happened in this process yet (CX-3 carrier).
      restartRequired: false,
    });
  });

  it('lists backups newest-first and flags restart after a successful save', async () => {
    const configPath = sandboxConfig();
    const dir = configPath.replace(/\/opencode\.json$/, '');
    const write = await put('/api/providers/nan', {
      hash: hashOf(configPath),
      name: 'NaN Renamed',
    });
    expect(write.status).toBe(200);
    const body = await (await get('/api/status')).json();
    expect(body['restartRequired']).toBe(true);
    const backups = body['backups'] as string[];
    expect(backups).toEqual(
      backupFiles(dir)
        .sort()
        .reverse()
        .map((n) => join(dir, BACKUP_DIR_NAME, n)),
    );
    expect(backups.length).toBe(1);
  });
});

// --- GET /api/catalog (WU7) + drift advisory end-to-end ----------------------
describe('bundled catalog + advisory drift (WU7)', () => {
  it('GET /api/catalog serves the offline snapshot — quotas and metadata, no pricing (CX-4)', async () => {
    sandboxConfig();
    const res = await get('/api/catalog');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.asOf).toBe(nanSnapshot.asOf);
    // Matched by npm+name metadata, not a provider id (PC-4).
    expect(body.provider).toEqual({
      npm: '@ai-sdk/openai-compatible',
      name: 'NaN',
    });
    // The MC-3 pre-fill source and the MC-5 drift oracle.
    expect(body.models['glm5.3-flash']).toMatchObject({
      name: 'GLM 5.3 Flash',
      contextWindow: 1048576,
    });
    expect(body.models['qwen3.8-flash'].contextWindow).toBe(262144);
    // Structurally no pricing anywhere in the served document.
    const keys: string[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object')
        for (const [k, child] of Object.entries(v)) {
          keys.push(k);
          walk(child);
        }
    };
    walk(body);
    expect(keys.filter((k) => /price|pricing|cost|charge/i.test(k))).toEqual(
      [],
    );
  });

  it('a drifted model still saves — and the declared 1M survives verbatim (MC-5 advisory)', async () => {
    const configPath = sandboxConfig();
    // The model carries the known drift cell 1,000,000 vs snapshot 262,144.
    const drift = await (await get('/api/status')).json();
    expect(drift['drift']).toContainEqual({
      provider: 'nan',
      model: 'qwen3.8-flash',
      field: 'contextWindow',
      declared: 1000000,
      snapshot: 262144,
      advisory: true,
    });
    // Drift never blocks: an ordinary edit to the drifted entry saves fine.
    const res = await put('/api/providers/nan/models/qwen3.8-flash', {
      hash: hashOf(configPath),
      model: { name: 'Renamed despite drift' },
    });
    expect(res.status).toBe(200);
    // Drift never rewrites: the declared contextWindow is byte-identical.
    const entry = modelsOf(treeOf(configPath), 'nan')[
      'qwen3.8-flash'
    ] as Record<string, unknown>;
    expect(entry['contextWindow']).toBe(1000000);
    expect(entry['name']).toBe('Renamed despite drift');
    // And the drift cell is still there afterwards (nothing was corrected).
    const after = await (await get('/api/status')).json();
    expect(after['drift']).toContainEqual(
      expect.objectContaining({
        model: 'qwen3.8-flash',
        declared: 1000000,
        snapshot: 262144,
      }),
    );
  });
});

// --- PUT /api/providers/:id --------------------------------------------------
describe('PUT /api/providers/:id — pass-through edits (PC-3) and error surface', () => {
  it('edits only baseURL: apiKey bytes unchanged; response {ok:true,hash}; echoed hash is the next valid base', async () => {
    const configPath = sandboxConfig();
    const before = readFileSync(configPath, 'utf8');
    const res = await put('/api/providers/nan', {
      hash: sha256(before),
      baseURL: 'https://new.example/v1',
    });
    expect(res.status).toBe(200);
    const w1 = await res.json();
    expect(w1).toEqual({ ok: true, hash: expect.any(String) });
    const after = readFileSync(configPath, 'utf8');
    const ch = changedLines(before, after);
    expect(ch.added.map(stripComma)).toEqual([
      '"baseURL": "https://new.example/v1"',
    ]);
    expect(ch.removed.map(stripComma)).toEqual([
      '"baseURL": "https://api.nan.example/v1"',
    ]);
    // PC-3 pass-through: apiKey bytes verbatim, never a masked placeholder.
    expect(treeOf(configPath).provider?.nan).toBeDefined();
    expect(modelsOf(treeOf(configPath), 'nan')['qwen3.6']).toBeTruthy();
    expect(after).toContain(SECRET);
    // The echoed hash is the next valid base (SCW-1 reload result).
    expect(w1['hash']).toBe(hashOf(configPath));
    const res2 = await put('/api/providers/nan', {
      hash: w1['hash'] as string,
      name: 'NaN Renamed',
    });
    expect(res2.status).toBe(200);
    expect(JSON.parse(readFileSync(configPath, 'utf8')).provider.nan.name).toBe(
      'NaN Renamed',
    );
  });

  it('explicit apiKey overwrite replaces the bytes; nothing else changes', async () => {
    const configPath = sandboxConfig();
    const before = readFileSync(configPath, 'utf8');
    const res = await put('/api/providers/nan', {
      hash: sha256(before),
      apiKey: 'sk-rotated',
    });
    expect(res.status).toBe(200);
    const after = readFileSync(configPath, 'utf8');
    const ch = changedLines(before, after);
    expect(ch.added.map(stripComma)).toEqual(['"apiKey": "sk-rotated"']);
    expect(ch.removed.map(stripComma)).toEqual([`"apiKey": "${SECRET}"`]);
    expect(after).not.toContain(SECRET);
  });

  it('stale base → 409 carrying expected/actual hashes; no write, no backup (SCW-2)', async () => {
    const configPath = sandboxConfig();
    const dir = configPath.replace(/\/opencode\.json$/, '');
    const base = hashOf(configPath);
    // External writer touches CONFIG after the client's load.
    const cur = treeOf(configPath);
    cur.provider = {
      ...cur.provider,
      nan: { ...(cur.provider?.['nan'] as object), name: 'external' },
    };
    writeFileSync(configPath, JSON.stringify(cur, null, 2));
    const res = await put('/api/providers/nan', { hash: base, name: 'mine' });
    expect(res.status).toBe(409);
    const body = await envelope(res);
    expect(body.error?.code).toBe('stale');
    expect(body.error?.expected).toBe(base);
    expect(body.error?.actual).toBe(hashOf(configPath));
    // Rejection is non-destructive: external bytes intact, zero backups.
    expect(treeOf(configPath).provider?.nan).toMatchObject({
      name: 'external',
    });
    expect(backupFiles(dir)).toEqual([]);
  });

  it('off-allowlist op → 400 naming the path (PatchError mapping)', async () => {
    const configPath = sandboxConfig();
    const dir = configPath.replace(/\/opencode\.json$/, '');
    const res = await post('/api/providers/nan/models', {
      hash: hashOf(configPath),
      modelId: '__proto__',
      model: { name: 'x' },
    });
    expect(res.status).toBe(400);
    const body = await envelope(res);
    expect(body.error?.code).toBe('off_allowlist');
    expect(body.error?.path).toBe('provider.nan.models.__proto__');
    expect(hashOf(configPath)).toBe(sha256(readFileSync(FIXTURE_PATH, 'utf8')));
    expect(backupFiles(dir)).toEqual([]);
  });

  it('unknown provider → 404 (provider id creation is out of scope, PC-4)', async () => {
    const configPath = sandboxConfig();
    const res = await put('/api/providers/ghost', {
      hash: hashOf(configPath),
      name: 'x',
    });
    expect(res.status).toBe(404);
    expect((await envelope(res)).error?.code).toBe('provider_not_found');
    expect(hashOf(configPath)).toBe(sha256(readFileSync(FIXTURE_PATH, 'utf8')));
  });

  it('malformed requests → 400 bad_request without touching CONFIG', async () => {
    const configPath = sandboxConfig();
    const before = readFileSync(configPath, 'utf8');
    const badJson = await app.request('/api/providers/nan', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(badJson.status).toBe(400);
    const missingHash = await put('/api/providers/nan', { name: 'x' });
    expect(missingHash.status).toBe(400);
    expect((await envelope(missingHash)).error?.code).toBe('bad_request');
    const wrongType = await put('/api/providers/nan', {
      hash: sha256(before),
      name: 123,
    });
    expect(wrongType.status).toBe(400);
    expect(readFileSync(configPath, 'utf8')).toBe(before);
  });
});

// --- /api/providers/:id/models ----------------------------------------------
describe('models POST/PUT/DELETE — whole-entry ops only (MC-1, MC-4)', () => {
  it('POST adds a sparse entry that keeps exactly the provided fields (MC-1)', async () => {
    const configPath = sandboxConfig();
    const before = readFileSync(configPath, 'utf8');
    const res = await post('/api/providers/nan/models', {
      hash: sha256(before),
      modelId: 'glm5.4-nano',
      model: { name: 'GLM 5.4 Nano', contextWindow: 262144 },
    });
    expect(res.status).toBe(200);
    const w = await envelope(res);
    expect(w.ok).toBe(true);
    const entry = modelsOf(treeOf(configPath), 'nan')['glm5.4-nano'];
    expect(entry).toEqual({ name: 'GLM 5.4 Nano', contextWindow: 262144 });
    expect(Object.keys(entry as object)).toEqual(['name', 'contextWindow']);
    // Pure addition: every pre-existing model survives untouched, and the
    // new key lands last (insertion order — nothing sorted or invented).
    expect(without(modelsOf(treeOf(configPath), 'nan'), 'glm5.4-nano')).toEqual(
      modelsOf(JSON.parse(before) as ConfigTree, 'nan'),
    );
    expect(Object.keys(modelsOf(treeOf(configPath), 'nan')).at(-1)).toBe(
      'glm5.4-nano',
    );
  });

  it('PUT merges additively: unmentioned fields survive untouched', async () => {
    const configPath = sandboxConfig();
    const before = modelsOf(treeOf(configPath), 'nan')['qwen3.6'] as Record<
      string,
      unknown
    >;
    const res = await put('/api/providers/nan/models/qwen3.6', {
      hash: hashOf(configPath),
      model: { contextWindow: 1000000 },
    });
    expect(res.status).toBe(200);
    const after = modelsOf(treeOf(configPath), 'nan')['qwen3.6'];
    expect(after).toEqual({ ...before, contextWindow: 1000000 });
    expect(Object.keys(after as object)).toEqual(Object.keys(before as object));
  });

  it('PUT merge onto a missing model → 404, never an invented entry', async () => {
    const configPath = sandboxConfig();
    const res = await put('/api/providers/nan/models/ghost-model', {
      hash: hashOf(configPath),
      model: { name: 'x' },
    });
    expect(res.status).toBe(404);
    expect((await envelope(res)).error?.code).toBe('model_not_found');
    expect(hashOf(configPath)).toBe(sha256(readFileSync(FIXTURE_PATH, 'utf8')));
  });

  it('invalid model edit → 400 naming the key path, zero backups (SCW-3)', async () => {
    const configPath = sandboxConfig();
    const dir = configPath.replace(/\/opencode\.json$/, '');
    const res = await put('/api/providers/nan/models/qwen3.8-flash', {
      hash: hashOf(configPath),
      model: { contextWindow: '1M' },
    });
    expect(res.status).toBe(400);
    const body = await envelope(res);
    expect(body.error?.code).toBe('invalid');
    expect(
      body.error?.issues?.some(
        (i) => i.path === 'provider.nan.models.qwen3.8-flash.contextWindow',
      ),
    ).toBe(true);
    expect(hashOf(configPath)).toBe(sha256(readFileSync(FIXTURE_PATH, 'utf8')));
    expect(backupFiles(dir)).toEqual([]);
  });

  it('DELETE removes exactly the confirmed entry; siblings byte-stable (MC-4)', async () => {
    const configPath = sandboxConfig();
    const dir = configPath.replace(/\/opencode\.json$/, '');
    const before = readFileSync(configPath, 'utf8');
    const res = await del('/api/providers/nan/models/mimo-v2.5', {
      hash: sha256(before),
    });
    expect(res.status).toBe(200);
    const after = readFileSync(configPath, 'utf8');
    expect(existsSync(join(dir, BACKUP_DIR_NAME))).toBe(true);
    expect(backupFiles(dir).length).toBe(1);
    const tree = JSON.parse(after);
    expect(Object.hasOwn(tree.provider.nan.models, 'mimo-v2.5')).toBe(false);
    // Everything except the removed entry is deep-equal (single-key change).
    expect(tree.provider.nan.models).toEqual(
      without(JSON.parse(before).provider.nan.models, 'mimo-v2.5'),
    );
    expect(changedLines(before, after).added).toEqual([]);
  });

  it('DELETE of a missing model → clean 404: no save, no backup churn', async () => {
    const configPath = sandboxConfig();
    const dir = configPath.replace(/\/opencode\.json$/, '');
    const res = await del('/api/providers/nan/models/ghost-model', {
      hash: hashOf(configPath),
    });
    expect(res.status).toBe(404);
    expect((await envelope(res)).error?.code).toBe('model_not_found');
    expect(hashOf(configPath)).toBe(sha256(readFileSync(FIXTURE_PATH, 'utf8')));
    expect(backupFiles(dir)).toEqual([]);
  });
});

// --- PUT /api/agents/:name/model ----------------------------------------------
describe('PUT /api/agents/:name/model — set/clear without name allowlist (OA-2)', () => {
  it('sets model on an unset agent; description sibling untouched', async () => {
    const configPath = sandboxConfig();
    const before = treeOf(configPath);
    const res = await put('/api/agents/sdd-spec-cheap/model', {
      hash: hashOf(configPath),
      model: 'nan/glm5.3-flash',
    });
    expect(res.status).toBe(200);
    const after = treeOf(configPath);
    expect(after.agent?.['sdd-spec-cheap']).toEqual({
      description: 'Cheap variant (synthetic)',
      model: 'nan/glm5.3-flash',
    });
    // Sibling agents deep-equal: only the targeted entry moved.
    expect(after.agent?.['sdd-spec']).toEqual(before.agent?.['sdd-spec']);
    expect(after.provider).toEqual(before.provider);
  });

  it('clears with null: only the model key is removed, siblings untouched', async () => {
    const configPath = sandboxConfig();
    const beforeTree = treeOf(configPath); // gentle-orchestrator: {description, model}
    const res = await put('/api/agents/gentle-orchestrator/model', {
      hash: hashOf(configPath),
      model: null,
    });
    expect(res.status).toBe(200);
    const afterTree = treeOf(configPath);
    const entry = afterTree.agent?.['gentle-orchestrator'] as Record<
      string,
      unknown
    >;
    expect('model' in entry).toBe(false);
    expect(entry).toEqual({
      description: 'Top-level orchestrator (synthetic)',
    });
    expect(Object.keys(entry)).toEqual(
      Object.keys(beforeTree.agent?.['gentle-orchestrator'] ?? {}).filter(
        (k) => k !== 'model',
      ),
    );
    // Nothing else moves: every other agent and the whole provider section
    // are deep-equal — model was the last key, so no sibling content changed.
    expect(afterTree.agent?.['sdd-spec']).toEqual(
      beforeTree.agent?.['sdd-spec'],
    );
    expect(afterTree.provider).toEqual(beforeTree.provider);
    expect(afterTree.mcp).toEqual(beforeTree.mcp);
  });

  it('accepts any agent present in CONFIG — no hardcoded names (OA-1/OA-2)', async () => {
    const configPath = sandboxConfig();
    const res = await put('/api/agents/review-security/model', {
      hash: hashOf(configPath),
      model: 'nan/qwen3.6',
    });
    expect(res.status).toBe(200);
    expect(treeOf(configPath).agent?.['review-security']).toMatchObject({
      model: 'nan/qwen3.6',
    });
  });

  it('unknown agent → 404 agent_not_found; nothing is invented', async () => {
    const configPath = sandboxConfig();
    const res = await put('/api/agents/ghost-agent/model', {
      hash: hashOf(configPath),
      model: 'nan/qwen3.6',
    });
    expect(res.status).toBe(404);
    expect((await envelope(res)).error?.code).toBe('agent_not_found');
    expect(hashOf(configPath)).toBe(sha256(readFileSync(FIXTURE_PATH, 'utf8')));
  });
});

// --- PC-1: missing/unparseable CONFIG never created or repaired -------------
describe('CONFIG load failures (PC-1)', () => {
  it('missing CONFIG → 404 config_missing on GET and PUT; the file is never created', async () => {
    const dir = mkdtempSync(join(sandbox, 'missing-'));
    tempDirs.push(dir);
    process.env.CONFIG_PATH = join(dir, 'opencode.json');
    expect(existsSync(join(dir, 'opencode.json'))).toBe(false);
    const getRes = await get('/api/config');
    expect(getRes.status).toBe(404);
    expect((await envelope(getRes)).error?.code).toBe('config_missing');
    const putRes = await put('/api/providers/nan', {
      hash: 'anything',
      name: 'x',
    });
    expect(putRes.status).toBe(404);
    expect((await envelope(putRes)).error?.code).toBe('config_missing');
    expect(existsSync(join(dir, 'opencode.json'))).toBe(false);
  });

  it('unparseable CONFIG → error surface; bytes are not repaired', async () => {
    const configPath = sandboxConfig();
    writeFileSync(configPath, '{not valid json!!');
    const res = await get('/api/config');
    expect(res.status).toBe(422);
    expect((await envelope(res)).error?.code).toBe('config_unparseable');
    expect(readFileSync(configPath, 'utf8')).toBe('{not valid json!!');
  });
});
