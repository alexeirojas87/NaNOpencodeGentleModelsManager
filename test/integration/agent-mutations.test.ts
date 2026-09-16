// agent-pipelines WU-2b task 2b.1 (RED) — gated prompt lockstep, user-owned
// delete, default-agent picker (SCW-7 c/d, AP-4/AP-6/AP-7, OA-4'). Same
// no-port sandbox pattern (#396): CONFIG_PATH/AUTH_PATH mkdtemp copies +
// app.request(); the live ~/.config is never touched. Zero-mutation is proven
// by bytes-equal + backup-count-unchanged on every rejection.
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
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

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

let sandbox: string;
let prevConfigEnv: string | undefined;
let prevAuthEnv: string | undefined;
let prevGentleStateEnv: string | undefined;
let prevGentleBinEnv: string | undefined;
beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'mdash-mutations-'));
  prevConfigEnv = process.env.CONFIG_PATH;
  prevAuthEnv = process.env.AUTH_PATH;
  // phase-agents-v3 task 1.1 fixture discipline (same rule as routes.test.ts):
  // version resolution is pinned to a sandbox 2.5.0 state.json so the
  // route-level v3 gates NEVER spawn a real gentle-ai binary here.
  prevGentleStateEnv = process.env.GENTLE_AI_STATE_PATH;
  prevGentleBinEnv = process.env.GENTLE_AI_BIN;
  writeFileSync(
    join(sandbox, 'state.json'),
    JSON.stringify({ installed_binary_version: '2.5.0' }),
  );
  process.env.GENTLE_AI_STATE_PATH = join(sandbox, 'state.json');
  delete process.env.GENTLE_AI_BIN;
  process.env.AUTH_PATH = join(sandbox, 'absent-auth.json');
});
afterAll(() => {
  if (prevConfigEnv === undefined) delete process.env.CONFIG_PATH;
  else process.env.CONFIG_PATH = prevConfigEnv;
  if (prevAuthEnv === undefined) delete process.env.AUTH_PATH;
  else process.env.AUTH_PATH = prevAuthEnv;
  if (prevGentleStateEnv === undefined) delete process.env.GENTLE_AI_STATE_PATH;
  else process.env.GENTLE_AI_STATE_PATH = prevGentleStateEnv;
  if (prevGentleBinEnv === undefined) delete process.env.GENTLE_AI_BIN;
  else process.env.GENTLE_AI_BIN = prevGentleBinEnv;
  rmSync(sandbox, { recursive: true, force: true });
});
afterEach(() => {
  // Version-fixture overrides never leak between tests.
  process.env.GENTLE_AI_STATE_PATH = join(sandbox, 'state.json');
  delete process.env.GENTLE_AI_BIN;
});
/** Point GENTLE_AI_STATE_PATH at a sandbox state.json declaring `version`. */
function stateFixture(version: string): void {
  const dir = mkdtempSync(join(sandbox, 'state-'));
  const statePath = join(dir, 'state.json');
  writeFileSync(
    statePath,
    JSON.stringify({ installed_binary_version: version }),
  );
  process.env.GENTLE_AI_STATE_PATH = statePath;
}
function sandboxConfig(): string {
  const dir = mkdtempSync(join(sandbox, 'case-'));
  const configPath = join(dir, 'opencode.json');
  copyFileSync(FIXTURE_PATH, configPath);
  process.env.CONFIG_PATH = configPath;
  return configPath;
}
const backupsIn = (configPath: string): number => {
  try {
    return readdirSync(join(dirname(configPath), BACKUP_DIR_NAME)).length;
  } catch {
    return 0;
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
const post = (p: string, b: unknown) => req('POST', p, b);
const put = (p: string, b: unknown) => req('PUT', p, b);
const del = (p: string, b: unknown) => req('DELETE', p, b);
const errOf = async (res: Response) =>
  (await res.json()) as { error: { code: string; message: string } };

/** Create the 2-role mypl pipeline; returns the post-create hash. */
async function createPipeline(configPath: string): Promise<string> {
  const role = (name: string) => ({
    name,
    description: `${name} role`,
    promptSource: 'template',
    prompt: `Do ${name} work.`,
  });
  const res = await post('/api/agent-pipelines', {
    hash: hashOf(configPath),
    pipeline: {
      name: 'mypl',
      orchestrator: { description: 'coordinate' },
      roles: [role('mypl-build'), role('mypl-review')],
      helpers: ['general'],
    },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { hash: string }).hash;
}
const seedUserAgent = async (configPath: string, name: string) => {
  const res = await post('/api/agents', {
    hash: hashOf(configPath),
    name,
    agent: { prompt: 'Original prompt.' },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { hash: string }).hash;
};

describe('PUT /api/agents/:name/prompt — user-owned + lockstep (SCW-7 c, AP-4)', () => {
  it('user-owned update = single value-op; only that value changes', async () => {
    const configPath = sandboxConfig();
    const hash = await seedUserAgent(configPath, 'my-helper');
    const before = treeOf(configPath);
    const res = await put('/api/agents/my-helper/prompt', {
      hash,
      prompt: 'Updated inline prompt — keep {file:mid-string} as text.',
    });
    expect(res.status).toBe(200);
    const tree = treeOf(configPath);
    expect(
      (tree.agent as Record<string, Record<string, unknown>>)['my-helper']
        .prompt,
    ).toBe('Updated inline prompt — keep {file:mid-string} as text.');
    expect(JSON.stringify(tree.provider)).toBe(JSON.stringify(before.provider));
    expect(backupsIn(configPath)).toBe(2); // create + update = two saves
  });

  it('pipeline ROLE update = ONE save with def roles[].prompt + row in lockstep', async () => {
    const configPath = sandboxConfig();
    const hash = await createPipeline(configPath);
    const backupsBefore = backupsIn(configPath);
    const res = await put('/api/agents/mypl-build/prompt', {
      hash,
      prompt: 'Regenerated by the maintainer.',
    });
    expect(res.status).toBe(200);
    expect(backupsIn(configPath)).toBe(backupsBefore + 1); // exactly one save
    const tree = treeOf(configPath);
    const row = (tree.agent as Record<string, Record<string, unknown>>)[
      'mypl-build'
    ];
    const def = tree['agent-pipelines']?.['mypl'] as PipelineDefinition;
    const defRole = def.roles.find((r) => r.name === 'mypl-build');
    expect(row.prompt).toBe('Regenerated by the maintainer.');
    expect(defRole?.prompt).toBe(row.prompt); // def/row match post-save (AP-4)
    // Sibling role row and orchestrator prompt untouched by this lockstep op.
    expect(
      (tree.agent as Record<string, Record<string, unknown>>)['mypl-review']
        .prompt,
    ).toBe('Do mypl-review work.');
  });

  it('orchestrator-name write → 400 generator_owned; zero mutation', async () => {
    const configPath = sandboxConfig();
    const hash = await createPipeline(configPath);
    const before = readFileSync(configPath, 'utf8');
    const backupsBefore = backupsIn(configPath);
    const res = await put('/api/agents/mypl/prompt', {
      hash,
      prompt: 'hand-written orchestrator',
    });
    expect(res.status).toBe(400);
    expect((await errOf(res)).error.code).toBe('generator_owned');
    expect(readFileSync(configPath, 'utf8')).toBe(before);
    expect(backupsIn(configPath)).toBe(backupsBefore);
  });

  it("reserved name → 400 zero-mutation; AC-5 gates + anchored {file:} (OA-4')", async () => {
    const configPath = sandboxConfig();
    const hash = await seedUserAgent(configPath, 'my-helper');
    const before = readFileSync(configPath, 'utf8');
    const base = backupsIn(configPath);
    const CASES: [string, unknown, string][] = [
      // 2.x default fixture (2.5.0): roster names answer reserved_name —
      // byte-preserved legacy semantics (:176 pin).
      ['sdd-spec', { hash, prompt: 'x' }, 'reserved_name'],
      ['my-helper', { hash, prompt: '{file:./x.md}' }, 'file_ref_rejected'],
      ['my-helper', { hash, prompt: '' }, 'prompt_required'],
      ['my-helper', { hash, prompt: 42 }, 'prompt_invalid'],
      [
        'my-helper',
        { hash, prompt: 'x'.repeat(65 * 1024) },
        'prompt_too_large',
      ],
      ['ghost-agent', { hash, prompt: 'ok' }, 'agent_not_found'],
    ];
    for (const [name, body, code] of CASES) {
      const res = await put(
        `/api/agents/${encodeURIComponent(name)}/prompt`,
        body,
      );
      expect(res.status, name).toBe(code === 'agent_not_found' ? 404 : 400);
      expect((await errOf(res)).error.code, name).toBe(code);
      expect(readFileSync(configPath, 'utf8')).toBe(before);
      expect(backupsIn(configPath)).toBe(base);
    }
  });

  it('3.x fixture: prompt PUT on a roster name → 400 roster_protected, NOT reserved_name', async () => {
    const configPath = sandboxConfig();
    stateFixture('3.0.0'); // sdd-spec already exists in the fixture config
    const hash = await seedUserAgent(configPath, 'my-helper');
    const before = readFileSync(configPath, 'utf8');
    const base = backupsIn(configPath);
    const res = await put('/api/agents/sdd-spec/prompt', {
      hash,
      prompt: 'try to rewrite the fixed skill-binding prompt',
    });
    expect(res.status).toBe(400);
    const e = (await errOf(res)).error;
    // DISTINCT code + create-once rationale + model-assignment note (D2).
    expect(e.code).toBe('roster_protected');
    expect(e.message).toContain('create-once');
    expect(e.message).toContain('model');
    expect(e.message).not.toContain('owned by gentle-ai sync');
    expect(readFileSync(configPath, 'utf8')).toBe(before); // zero mutation
    expect(backupsIn(configPath)).toBe(base); // zero backups
    void hash;
  });

  it('3.x fixture: unknown-fixture mode still answers reserved_name for roster names', async () => {
    const configPath = sandboxConfig();
    // Point at an ABSENT state file with a garbage bin stub → conservative
    // unknown → legacy semantics byte-preserved (roster gate never fires).
    const dir = mkdtempSync(join(sandbox, 'state-'));
    writeFileSync(join(dir, 'fake-gentle-ai.sh'), '#!/bin/sh\nprintf oops\n');
    const { chmodSync } = await import('node:fs');
    chmodSync(join(dir, 'fake-gentle-ai.sh'), 0o755);
    process.env.GENTLE_AI_STATE_PATH = join(dir, 'absent-state.json');
    process.env.GENTLE_AI_BIN = join(dir, 'fake-gentle-ai.sh');
    const hash = await seedUserAgent(configPath, 'my-helper');
    const res = await put('/api/agents/sdd-spec/prompt', {
      hash,
      prompt: 'x',
    });
    expect(res.status).toBe(400);
    expect((await errOf(res)).error.code).toBe('reserved_name');
  });
});

describe('DELETE /api/agents/:name — user-owned standalone only (SCW-7 d)', () => {
  it('user-owned delete: backup exists, ONLY that entry removed, fresh hash', async () => {
    const configPath = sandboxConfig();
    const hash = await seedUserAgent(configPath, 'doomed-agent');
    await seedUserAgent(configPath, 'keeper-agent');
    const res = await del('/api/agents/doomed-agent', {
      hash: hashOf(configPath),
    });
    void hash;
    expect(res.status).toBe(200);
    const w = (await res.json()) as { ok: true; hash: string };
    expect(w.hash).toBe(hashOf(configPath));
    const agents = Object.keys(treeOf(configPath).agent as object);
    expect(agents).not.toContain('doomed-agent');
    expect(agents).toContain('keeper-agent');
    expect(agents).toContain('gentle-orchestrator'); // reserved rows intact
    expect(backupsIn(configPath)).toBe(3); // 2 seeds + delete
  });

  it('member → 400 naming the owning pipeline; reserved → 400; zero mutation', async () => {
    const configPath = sandboxConfig();
    await createPipeline(configPath);
    const before = readFileSync(configPath, 'utf8');
    const base = backupsIn(configPath);
    for (const [name, code] of [
      ['mypl-build', 'pipeline_owned'],
      ['mypl', 'pipeline_owned'],
      // 2.x default fixture (2.5.0): roster name → reserved_name — the
      // :227 pin's legacy semantics, byte-preserved.
      ['sdd-spec', 'reserved_name'],
      ['gentle-orchestrator', 'reserved_name'],
    ] as const) {
      const res = await del(`/api/agents/${name}`, {
        hash: hashOf(configPath),
      });
      expect(res.status, name).toBe(400);
      const e = (await errOf(res)).error;
      expect(e.code, name).toBe(code);
      if (code === 'pipeline_owned') expect(e.message).toContain('mypl');
    }
    expect(readFileSync(configPath, 'utf8')).toBe(before);
    expect(backupsIn(configPath)).toBe(base);
  });

  it('3.x fixture: DELETE roster name → 400 roster_protected; model PUT on the SAME name → 200', async () => {
    const configPath = sandboxConfig();
    stateFixture('3.0.0'); // sdd-spec already exists in the fixture config
    const before = readFileSync(configPath, 'utf8');
    const base = backupsIn(configPath);
    // The create-once policy blocks deletion (spec scenario "Delete blocked")…
    const res = await del('/api/agents/sdd-spec', {
      hash: hashOf(configPath),
    });
    expect(res.status).toBe(400);
    const e = (await errOf(res)).error;
    expect(e.code).toBe('roster_protected');
    expect(e.message).toContain('create-once');
    expect(readFileSync(configPath, 'utf8')).toBe(before); // zero mutation
    expect(backupsIn(configPath)).toBe(base);
    // …while model assignment stays available (spec scenario "Model edit
    // allowed" — the model PUT route was never version- or roster-gated).
    const model = await put('/api/agents/sdd-spec/model', {
      hash: hashOf(configPath),
      model: 'nan/qwen3.6',
    });
    expect(model.status).toBe(200);
    const tree = treeOf(configPath);
    expect(
      (tree.agent as Record<string, Record<string, unknown>>)['sdd-spec'].model,
    ).toBe('nan/qwen3.6');
  });

  it('unknown name → 404; pipeline member survives (AP-5 is the delete path)', async () => {
    const configPath = sandboxConfig();
    await createPipeline(configPath);
    const res = await del('/api/agents/ghost-agent', {
      hash: hashOf(configPath),
    });
    expect(res.status).toBe(404);
    expect((await errOf(res)).error.code).toBe('agent_not_found');
    expect(Object.keys(treeOf(configPath).agent as object)).toContain(
      'mypl-build',
    );
  });
});

describe('PUT /api/config/default-agent — picker gate mirrors C-R1d throw set', () => {
  it('hidden subagent / unknown / hidden primary → 400 zero-mutation', async () => {
    const configPath = sandboxConfig();
    await createPipeline(configPath);
    // Seed a hidden mode:"all" entry straight into the sandbox copy (the
    // dashboard never creates one — the loader accepts it: hidden check in
    // defaultInfo is mode-independent, C-R1d/R1b register item 3).
    const seeded = treeOf(configPath);
    seeded.agent = {
      ...seeded.agent,
      'hidden-primary': { hidden: true, prompt: 'x' },
    };
    const { writeFileSync } = await import('node:fs');
    writeFileSync(configPath, JSON.stringify(seeded, null, 2));
    const before = readFileSync(configPath, 'utf8');
    const base = backupsIn(configPath);
    // A hidden SUBAGENT, a GHOST and a hidden PRIMARY each mirror one
    // defaultInfo throw (is a subagent / not found / is hidden).
    for (const target of ['mypl-build', 'ghost-agent', 'hidden-primary']) {
      const res = await put('/api/config/default-agent', {
        hash: hashOf(configPath),
        agent: target,
      });
      expect(res.status, target).toBe(400);
      expect((await errOf(res)).error.code, target).toBe(
        'default_agent_invalid',
      );
    }
    expect(readFileSync(configPath, 'utf8')).toContain('default_agent'); // fixture key intact
    expect(readFileSync(configPath, 'utf8')).toBe(before);
    expect(backupsIn(configPath)).toBe(base);
  });

  it('valid primary saves; absent-mode user agent passes (mode!=="subagent" ∧ hidden!==true)', async () => {
    const configPath = sandboxConfig();
    const hash = await createPipeline(configPath);
    const res = await put('/api/config/default-agent', { hash, agent: 'mypl' });
    expect(res.status).toBe(200);
    expect(treeOf(configPath).default_agent).toBe('mypl');
    const w = (await res.json()) as { hash: string };
    const res2 = await put('/api/config/default-agent', {
      hash: w.hash,
      agent: 'gentle-orchestrator',
    });
    expect(res2.status).toBe(200); // reserved-but-visible primary is selectable
  });

  it('null-clear unsets the key ⇒ build fallback stays valid (C-R1d inverse)', async () => {
    const configPath = sandboxConfig();
    const hash = await seedUserAgent(configPath, 'someone');
    const set = await put('/api/config/default-agent', {
      hash,
      agent: 'someone',
    });
    expect(set.status).toBe(200);
    const w = (await set.json()) as { hash: string };
    const clear = await put('/api/config/default-agent', {
      hash: w.hash,
      agent: null,
    });
    expect(clear.status).toBe(200);
    expect('default_agent' in treeOf(configPath)).toBe(false);
  });
});
