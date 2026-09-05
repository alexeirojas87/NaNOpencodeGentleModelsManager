// agent-pipelines WU-2a task 2a.1 (RED) — pipeline lifecycle endpoints
// (AP-2..AP-5, SCW-7' a). Sandbox rule (per #396): CONFIG_PATH/AUTH_PATH are
// pointed at mkdtemp copies; routes are driven with app.request() — NO port,
// NEVER the live ~/.config. One-save is proven structurally: each runSave
// leaves exactly one backup file (SCW-4), and a rejected batch leaves zero.
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { app } from '../../server/src/app';
import { BACKUP_DIR_NAME } from '../../server/src/config/backup';
import type { ConfigTree } from '../../server/src/config/load';
import type { PipelineDefinition } from '../../shared/types';

const FIXTURE_PATH = fileURLToPath(
  new URL('../fixtures/config.sample.json', import.meta.url),
);
const sha256 = (s: string): string =>
  createHash('sha256').update(s, 'utf8').digest('hex');
const hashOf = (p: string): string => sha256(readFileSync(p, 'utf8'));
const treeOf = (p: string): ConfigTree =>
  JSON.parse(readFileSync(p, 'utf8')) as ConfigTree;

const tempDirs: string[] = [];
let sandbox: string;
let prevConfigEnv: string | undefined;
let prevAuthEnv: string | undefined;

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'mdash-pipelines-'));
  prevConfigEnv = process.env.CONFIG_PATH;
  prevAuthEnv = process.env.AUTH_PATH;
  process.env.AUTH_PATH = join(sandbox, 'absent-auth.json');
});
afterAll(() => {
  if (prevConfigEnv === undefined) delete process.env.CONFIG_PATH;
  else process.env.CONFIG_PATH = prevConfigEnv;
  if (prevAuthEnv === undefined) delete process.env.AUTH_PATH;
  else process.env.AUTH_PATH = prevAuthEnv;
  rmSync(sandbox, { recursive: true, force: true });
});

function sandboxConfig(): string {
  const dir = mkdtempSync(join(sandbox, 'case-'));
  tempDirs.push(dir);
  const configPath = join(dir, 'opencode.json');
  copyFileSync(FIXTURE_PATH, configPath);
  process.env.CONFIG_PATH = configPath;
  return configPath;
}
const backupsIn = (configPath: string): string[] => {
  try {
    return readdirSync(join(dirname(configPath), BACKUP_DIR_NAME));
  } catch {
    return [];
  }
};

async function req(method: string, path: string, body?: unknown) {
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
const post = (path: string, body: unknown) => req('POST', path, body);
const put = (path: string, body: unknown) => req('PUT', path, body);
const del = (path: string, body: unknown) => req('DELETE', path, body);
const get = (path: string) => req('GET', path);

const role = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  description: `${name} role`,
  promptSource: 'template',
  prompt: `Do ${name} work.`,
  ...extra,
});
const orch: { description: string; model?: string } = {
  description: 'coordinate mypl',
};
const BODY = (
  hash: string,
  name = 'mypl',
  roles = ['build', 'review', 'spec'],
) => ({
  hash,
  pipeline: {
    name,
    orchestrator: { ...orch },
    roles: roles.map((r) => role(`${name}-${r}`)),
    helpers: ['general'],
  },
});

describe("POST /api/agent-pipelines — happy batch (AP-2, AC-4' generated persist)", () => {
  it('3-role pipeline: ONE save writes key + 4 rows; siblings byte-identical', async () => {
    const configPath = sandboxConfig();
    const before = readFileSync(configPath, 'utf8');
    const res = await post('/api/agent-pipelines', BODY(hashOf(configPath)));
    expect(res.status).toBe(200);
    const w = (await res.json()) as { ok: true; hash: string };
    expect(w.hash).toBe(hashOf(configPath));
    expect(backupsIn(configPath)).toHaveLength(1); // exactly one runSave

    const tree = treeOf(configPath);
    const agents = tree.agent as Record<string, Record<string, unknown>>;
    // Key + orchestrator + 3 roles; fixture rows untouched.
    expect(Object.keys(tree['agent-pipelines'] as object)).toEqual(['mypl']);
    expect(Object.keys(agents)).toEqual([
      'gentle-orchestrator',
      'sdd-spec',
      'sdd-spec-cheap',
      'sdd-spec-deep',
      'jd-judge-a',
      'review-security',
      'mypl',
      'mypl-build',
      'mypl-review',
      'mypl-spec',
    ]);
    // Siblings + unrelated top-level bytes unchanged (SCW-6, AP-2 golden):
    // everything outside `agent`/`agent-pipelines` serializes identically,
    // and every pre-existing agent row is deep-equal to its before-bytes.
    const beforeTree = JSON.parse(before) as ConfigTree;
    for (const key of Object.keys(beforeTree)) {
      if (key === 'agent' || key === 'agent-pipelines') continue;
      expect(JSON.stringify(tree[key]), key).toBe(
        JSON.stringify(beforeTree[key]),
      );
    }
    for (const key of Object.keys(beforeTree.agent as object)) {
      expect(JSON.stringify(agents[key]), key).toBe(
        JSON.stringify((beforeTree.agent as Record<string, unknown>)[key]),
      );
    }

    // Orchestrator row: plain non-hidden primary, generated prompt + task map.
    const o = agents['mypl'];
    expect(o['mode']).toBe('primary');
    expect('hidden' in o).toBe(false);
    const prompt = o['prompt'] as string;
    expect(prompt).toContain('`mypl`');
    for (const r of ['mypl-build', 'mypl-review', 'mypl-spec'])
      expect(prompt).toContain(`\`${r}\``);
    const perm = o['permission'] as {
      question: string;
      task: Record<string, string>;
    };
    expect(perm.question).toBe('allow');
    expect(Object.keys(perm.task)).toEqual([
      '*',
      'mypl-build',
      'mypl-review',
      'mypl-spec',
      'general',
    ]);
    expect(JSON.stringify(perm.task)).toContain('{"*":"deny"');
    // Role rows: hidden subagents, NO permission, no temperature/variant.
    for (const r of ['mypl-build', 'mypl-review', 'mypl-spec']) {
      const entry = agents[r];
      expect(entry['mode']).toBe('subagent');
      expect(entry['hidden']).toBe(true);
      expect('permission' in entry).toBe(false);
      expect('temperature' in entry).toBe(false);
      expect('variant' in entry).toBe(false);
    }
    // Definition is the exact AP-1 input shape (no generated fields stored).
    const def = tree['agent-pipelines']?.['mypl'] as PipelineDefinition;
    expect(Object.keys(def)).toEqual(['roles', 'orchestrator', 'helpers']);
    expect(Object.keys(def.roles[0])).toEqual([
      'name',
      'description',
      'promptSource',
      'prompt',
    ]);
    expect(
      Object.keys((tree.agent as Record<string, object>)['mypl-build']),
    ).toEqual(['mode', 'hidden', 'description', 'prompt']);
  });

  it('optional models persist; absent model keys stay absent (C-R1e, AC-6)', async () => {
    const configPath = sandboxConfig();
    const body = BODY(hashOf(configPath));
    const pipeline = body.pipeline;
    pipeline.orchestrator = { ...orch, model: 'nan/qwen3.6' };
    pipeline.roles[0] = role('mypl-build', { model: 'nan/glm5.3-flash' });
    const res = await post('/api/agent-pipelines', body);
    expect(res.status).toBe(200);
    const agents = treeOf(configPath).agent as Record<
      string,
      Record<string, unknown>
    >;
    expect(agents['mypl']['model']).toBe('nan/qwen3.6');
    expect(agents['mypl-build']['model']).toBe('nan/glm5.3-flash');
    expect('model' in agents['mypl-review']).toBe(false);
  });
});

describe('POST /api/agent-pipelines — batch gates are pre-disk zero-mutation', () => {
  const rejected = async (
    configPath: string,
    body: unknown,
    code: string,
    names: string[] = [],
  ) => {
    const before = readFileSync(configPath, 'utf8');
    const baseBackups = backupsIn(configPath).length;
    const res = await post('/api/agent-pipelines', body);
    expect(res.status, JSON.stringify(body)).toBe(400);
    const e = (
      (await res.json()) as {
        error: { code: string; message: string; field?: string };
      }
    ).error;
    expect(e.code).toBe(code);
    for (const n of names) expect(e.message + (e.field ?? '')).toContain(n);
    expect(readFileSync(configPath, 'utf8')).toBe(before); // zero bytes
    // Never reached the backup stage (or beyond this test's own seeds).
    expect(backupsIn(configPath)).toHaveLength(baseBackups);
  };

  it('intra-batch duplicate role → 400 naming the duplicate', async () => {
    const configPath = sandboxConfig();
    const body = BODY(hashOf(configPath));
    body.pipeline.roles[1] = role('mypl-build');
    await rejected(configPath, body, 'duplicate_name', ['mypl-build']);
  });

  it("role named like the orchestrator → 400 duplicate_name (AP-6 '≡ key)", async () => {
    const configPath = sandboxConfig();
    const body = BODY(hashOf(configPath));
    body.pipeline.roles[0] = role('mypl');
    await rejected(configPath, body, 'duplicate_name', ['mypl']);
  });

  it('existing-name collision → 400 agent_exists', async () => {
    const configPath = sandboxConfig();
    // Seed a real user-owned agent to collide with (fixture agents are all
    // reserved — that path is covered by the reserved_name case below).
    const seeded = await post('/api/agents', {
      hash: hashOf(configPath),
      name: 'worker',
      agent: { prompt: 'Existing standalone worker.' },
    });
    expect(seeded.status).toBe(200);
    const body = BODY(((await seeded.json()) as { hash: string }).hash);
    body.pipeline.roles[2] = role('worker');
    await rejected(configPath, body, 'agent_exists', ['worker']);
  });

  it('def referencing reserved role sdd-custom → 400 reserved_name (SCW-7 a)', async () => {
    const configPath = sandboxConfig();
    const body = BODY(hashOf(configPath));
    body.pipeline.roles[0] = role('sdd-custom');
    await rejected(configPath, body, 'reserved_name', ['sdd-custom']);
  });

  it("generated fields in batch body → 400 naming the field (AC-4': mode/hidden/permission)", async () => {
    const configPath = sandboxConfig();
    for (const field of ['mode', 'hidden', 'permission']) {
      const body = BODY(hashOf(configPath));
      (body.pipeline.roles[0] as Record<string, unknown>)[field] =
        field === 'permission' ? {} : true;
      await rejected(configPath, body, 'unknown_field', [field]);
      const top = BODY(hashOf(configPath));
      (top.pipeline.orchestrator as Record<string, unknown>)[field] =
        field === 'permission' ? {} : true;
      await rejected(configPath, top, 'unknown_field', [field]);
    }
  });

  it('AP-1 shape violation names its path; helper glob meta rejected', async () => {
    const configPath = sandboxConfig();
    const body = BODY(hashOf(configPath));
    (body.pipeline.roles[1] as Record<string, unknown>)['temperature'] = 0.2;
    await rejected(configPath, body, 'invalid_shape', ['roles.1']);
    const helper = BODY(hashOf(configPath));
    helper.pipeline.helpers = ['*'];
    await rejected(configPath, helper, 'invalid_shape', ['helpers']);
  });

  it('integer-like role name rejected (task-map key-order would break deny-star first)', async () => {
    const configPath = sandboxConfig();
    const body = BODY(hashOf(configPath));
    body.pipeline.roles[0] = role('123');
    await rejected(configPath, body, 'name_invalid', ['123']);
  });
});

describe('PUT/DELETE /api/agent-pipelines/mypl — edit lockstep + zero orphans', () => {
  async function create(configPath: string): Promise<string> {
    const res = await post('/api/agent-pipelines', BODY(hashOf(configPath)));
    expect(res.status).toBe(200);
    return ((await res.json()) as { hash: string }).hash;
  }

  it('edit adding/dropping roles rewrites def + rows in ONE save (AP-4)', async () => {
    const configPath = sandboxConfig();
    const hash = await create(configPath);
    const body = BODY(hash, 'mypl', ['review', 'test']); // drop build+spec, add test
    const res = await put('/api/agent-pipelines/mypl', body);
    expect(res.status).toBe(200);
    expect(backupsIn(configPath)).toHaveLength(2); // create + edit = 2 saves

    const tree = treeOf(configPath);
    const agents = tree.agent as Record<string, Record<string, unknown>>;
    expect(Object.keys(tree['agent-pipelines'] as object)).toEqual(['mypl']);
    expect('mypl-build' in agents).toBe(false); // dropped row gone
    expect('mypl-spec' in agents).toBe(false);
    const def = tree['agent-pipelines']?.['mypl'] as PipelineDefinition;
    expect(def.roles.map((r) => r.name)).toEqual(['mypl-review', 'mypl-test']);
    // Regenerated orchestrator names exactly the CURRENT roles (AP-4 lockstep).
    const prompt = agents['mypl']['prompt'] as string;
    expect(prompt).toContain('`mypl-review`');
    expect(prompt).toContain('`mypl-test`');
    expect(prompt).not.toContain('`mypl-build`');
    const task = (
      agents['mypl']['permission'] as { task: Record<string, string> }
    ).task;
    expect(Object.keys(task)).toEqual([
      '*',
      'mypl-review',
      'mypl-test',
      'general',
    ]);
  });

  it('PUT on unknown pipeline → 404; POST onto existing def → 400 pipeline_exists', async () => {
    const configPath = sandboxConfig();
    expect(
      (await put('/api/agent-pipelines/nope', BODY('x', 'nope'))).status,
    ).toBe(404);
    const hash = await create(configPath);
    const dup = await post('/api/agent-pipelines', BODY(hash));
    expect(dup.status).toBe(400);
    expect(((await dup.json()) as { error: { code: string } }).error.code).toBe(
      'pipeline_exists',
    );
  });

  it('DELETE removes key + N+1 rows in one save; backup restores pre-delete; zero orphans (AP-5)', async () => {
    const configPath = sandboxConfig();
    const hash = await create(configPath);
    const preDelete = readFileSync(configPath, 'utf8');
    const res = await del('/api/agent-pipelines/mypl', { hash });
    expect(res.status).toBe(200);
    expect(backupsIn(configPath)).toHaveLength(2);

    const tree = treeOf(configPath);
    expect('mypl' in (tree['agent-pipelines'] ?? {})).toBe(false);
    const agents = tree.agent as Record<string, object>;
    for (const n of ['mypl', 'mypl-build', 'mypl-review', 'mypl-spec'])
      expect(n in agents).toBe(false);
    expect(Object.keys(agents)).toEqual([
      'gentle-orchestrator',
      'sdd-spec',
      'sdd-spec-cheap',
      'sdd-spec-deep',
      'jd-judge-a',
      'review-security',
    ]);
    // Zero orphans BOTH directions: no def names a removed row, no row is
    // named by a surviving def.
    const defNames = new Set(
      Object.values(tree['agent-pipelines'] ?? {}).flatMap((d) => [
        ...d.roles.map((r) => r.name),
      ]),
    );
    expect(defNames.size).toBe(0);
    // The newest backup restores the pre-delete bytes exactly (SCW-4).
    const dir = join(dirname(configPath), BACKUP_DIR_NAME);
    const backups = readdirSync(dir)
      .map((f) => join(dir, f))
      .sort(); // timestamped names — lexical order is chronological
    const restored = readFileSync(
      backups[backups.length - 1] as string,
      'utf8',
    );
    expect(restored).toBe(preDelete);
  });

  it('standalone DELETE of a pipeline member via /api/agents is rejected (WU-2b gate; pre-wired here)', async () => {
    const configPath = sandboxConfig();
    const hash = await create(configPath);
    void hash;
    // 2b.1 owns this assertion for the agents route; pipelines route parity:
    // editing through PUT with a role name owned by ANOTHER pipeline → 400.
    const hash2 = hashOf(configPath);
    const other = BODY(hash2, 'otherpl', ['x']);
    other.pipeline.roles[0] = role('mypl-build');
    const res = await post('/api/agent-pipelines', other);
    expect(res.status).toBe(400);
    const e = (
      (await res.json()) as { error: { code: string; message: string } }
    ).error;
    expect(e.code).toBe('pipeline_owned');
    expect(e.message).toContain('mypl');
  });
});

// agent-pipelines WU-3b task 3b.1 dependency — the definition READ surface
// (apply-progress #479 deviation 1 resolution): design #472 lists only
// POST/PUT/DELETE and words the ride on GET /api/config, but that response is
// pinned by routes.test.ts to an exact key set; adding `pipelines` there
// would break a committed regression pin. The read-only GET route below keeps
// both green: builders/edit-prefill and view grouping consume definitions
// here. Read-only, no auth beyond CX-1 (the whole API is local-only).
describe('GET /api/agent-pipelines — definition read surface', () => {
  it('answers {} when CONFIG carries no definitions (empty state)', async () => {
    sandboxConfig();
    const res = await get('/api/agent-pipelines');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pipelines: {} });
  });

  it('returns the created definition verbatim — the edit-prefill source', async () => {
    const configPath = sandboxConfig();
    const body = BODY(hashOf(configPath), 'mypl', ['build', 'review']);
    body.pipeline.roles[0] = role('mypl-build', { model: 'nan/qwen3.6' });
    const created = await post('/api/agent-pipelines', body);
    expect(created.status).toBe(200);

    const res = await get('/api/agent-pipelines');
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      pipelines: Record<string, PipelineDefinition>;
    };
    expect(Object.keys(payload.pipelines)).toEqual(['mypl']);
    // Exactly the stored def — generator inputs, no rows, no invented fields.
    expect(payload.pipelines.mypl).toEqual(
      treeOf(configPath)['agent-pipelines']?.mypl,
    );
    expect(payload.pipelines.mypl.roles[0]).toEqual({
      name: 'mypl-build',
      model: 'nan/qwen3.6',
      description: 'mypl-build role',
      promptSource: 'template',
      prompt: 'Do mypl-build work.',
    });
    expect(JSON.stringify(payload)).not.toContain('"permission"'); // rows stay in `agent`
  });

  it('externally-authored definitions pass through tolerantly (read never validates)', async () => {
    const configPath = sandboxConfig();
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as ConfigTree;
    raw['agent-pipelines'] = {
      hand: {
        roles: [{ name: 'hand-x', prompt: 'External text.' }],
        orchestrator: { description: 'd' },
      },
    } as unknown as ConfigTree['agent-pipelines'];
    writeFileSync(configPath, JSON.stringify(raw, null, 2));
    const res = await get('/api/agent-pipelines');
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { pipelines: Record<string, object> };
    // The read surface mirrors CONFIG; shape policing belongs to the WRITE gates.
    expect(payload.pipelines.hand).toEqual(
      (raw['agent-pipelines'] as Record<string, object>)['hand'],
    );
  });
});
