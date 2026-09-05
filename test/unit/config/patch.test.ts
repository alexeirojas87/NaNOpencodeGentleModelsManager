// WU3.3 (RED) — threat file-write #1: allowlist enforcement (SCW-7, OA-4,
// PC-4, design §Config-Editing-Core). patch() must accept EXACTLY the
// allowlisted paths, reject anything else naming the offending path, never
// mutate its input, and keep untouched subtrees reference-identical
// (path-copying, not a full re-clone). Pure unit: no fs, sandbox rule N/A.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { ConfigTree } from '../../../server/src/config/load';
import { PatchError, patch } from '../../../server/src/config/patch';
import type { PatchOp } from '../../../server/src/config/patch';

const FIXTURE_PATH = fileURLToPath(
  new URL('../../fixtures/config.sample.json', import.meta.url),
);
const RAW = readFileSync(FIXTURE_PATH, 'utf8');
const fixtureTree = (): ConfigTree => JSON.parse(RAW) as ConfigTree;

const set = (path: string[], value: unknown): PatchOp => ({ path, value });
const del = (path: string[]): PatchOp => ({ path, remove: true });

function rejected(tree: ConfigTree, op: PatchOp): PatchError {
  let err: unknown;
  try {
    patch(tree, [op]);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(PatchError);
  return err as PatchError;
}

function providers(tree: ConfigTree): Record<string, ConfigTree> {
  return tree.provider as Record<string, ConfigTree>;
}

describe('patch — accepts exactly the provider allowlist (SCW-7)', () => {
  it('applies name/npm/baseURL/apiKey and model add/replace/remove in one batch', () => {
    const tree = fixtureTree();
    const result = patch(tree, [
      set(['provider', 'nan', 'name'], 'NaN Renamed'),
      set(['provider', 'nan', 'npm'], '@ai-sdk/renamed'),
      set(
        ['provider', 'nan', 'options', 'baseURL'],
        'https://rotated.example/v1',
      ),
      set(['provider', 'nan', 'options', 'apiKey'], 'sk-verbatim-new-key'),
      set(['provider', 'headroom', 'models', 'glm5.3-flash'], {
        name: 'GLM 5.3 Flash',
        contextWindow: 262144,
      }),
      set(['provider', 'nan', 'models', 'qwen3.6'], {
        name: 'Qwen 3.6',
        contextWindow: 524288,
      }),
      del(['provider', 'nan', 'models', 'mimo-v2.5']),
    ]);

    expect(result.applied).toBe(7);
    const nan = providers(result.tree).nan;
    expect(nan.name).toBe('NaN Renamed');
    expect(nan.npm).toBe('@ai-sdk/renamed');
    // apiKey bytes are taken verbatim (PC-3 pass-through source of truth).
    expect((nan.options as ConfigTree).apiKey).toBe('sk-verbatim-new-key');
    expect((nan.models as Record<string, unknown>)['qwen3.6']).toEqual({
      name: 'Qwen 3.6',
      contextWindow: 524288,
    });
    expect('mimo-v2.5' in (nan.models as object)).toBe(false);
    // Key order of untouched entries survives the surgery (SCW-6 precond.).
    expect(Object.keys(nan.models as object)).toEqual([
      'glm5.3-flash',
      'qwen3.6',
      'qwen3.8-flash',
      'deepseek-v4-flash',
      'gemma4',
    ]);
    const headroomModels = providers(result.tree).headroom.models as object;
    expect(Object.keys(headroomModels)).toEqual(['glm5.3-flash']);
    // Input never mutated.
    expect(JSON.stringify(tree, null, 2)).toBe(RAW);
  });
});

describe('patch — accepts exactly the agent allowlist (OA-2/OA-4 UI set)', () => {
  it('applies model/description/temperature/variant and default_agent', () => {
    const tree = fixtureTree();
    const result = patch(tree, [
      set(
        ['agent', 'gentle-orchestrator', 'description'],
        'Updated description',
      ),
      set(['agent', 'sdd-spec-cheap', 'temperature'], 0.2),
      set(['agent', 'sdd-spec-deep', 'variant'], 'high'),
      set(['agent', 'jd-judge-a', 'model'], 'nan/glm5.3-flash'),
      del(['agent', 'sdd-spec', 'model']),
      set(['default_agent'], 'sdd-spec'),
    ]);

    expect(result.applied).toBe(6);
    const agent = result.tree.agent as Record<string, ConfigTree>;
    expect(agent['gentle-orchestrator'].description).toBe(
      'Updated description',
    );
    expect(agent['gentle-orchestrator'].model).toBe('nan/qwen3.8-flash');
    expect(agent['sdd-spec-cheap'].temperature).toBe(0.2);
    expect(agent['sdd-spec-deep'].variant).toBe('high');
    expect(agent['jd-judge-a'].model).toBe('nan/glm5.3-flash');
    // Clearing model removes only the key — the entry itself stays.
    expect('model' in agent['sdd-spec']).toBe(false);
    expect(result.tree.default_agent).toBe('sdd-spec');
  });

  it('is generic over arbitrary ids and creates missing containers (PC-4, MC-3)', () => {
    const tree: ConfigTree = { provider: { solo: { name: 'Solo' } } };
    const out = patch(tree, [
      set(['provider', 'solo', 'models', 'glm5.3-flash'], { name: 'New' }),
      set(['agent', 'brand-new-agent', 'model'], 'solo/glm5.3-flash'),
    ]).tree;
    expect(providers(out).solo.models).toEqual({
      'glm5.3-flash': { name: 'New' },
    });
    expect(
      (out.agent as Record<string, ConfigTree>)['brand-new-agent'].model,
    ).toBe('solo/glm5.3-flash');
  });
});

describe('patch — rejects off-allowlist mutation naming the path (threat file-write #1)', () => {
  const OFF_ALLOWLIST: string[][] = [
    ['$schema'],
    ['mcp'],
    ['mcp', 'example-server', 'enabled'],
    ['compaction', 'reserved'],
    ['instructions', '0'],
    ['share'],
    ['custom', 'note'],
    ['totally-unknown-top-key'],
    ['provider'],
    ['provider', 'nan'],
    ['provider', 'nan', 'env'],
    ['provider', 'nan', 'options'],
    ['provider', 'nan', 'options', 'timeout'],
    ['provider', 'nan', 'models'],
    ['provider', 'nan', 'models', 'qwen3.6', 'contextWindow'],
    ['agent'],
    ['agent', 'gentle-orchestrator'],
    ['agent', 'gentle-orchestrator', 'prompt'],
    ['agent', 'jd-judge-a', 'tools'],
    ['default_agent', 'nested'],
  ];

  it.each(OFF_ALLOWLIST.map((path) => [path]))(
    'rejects mutation of %j with code off_allowlist naming the path',
    (path) => {
      const tree = fixtureTree();
      const err = rejected(tree, set(path, 'nope'));
      expect(err.code).toBe('off_allowlist');
      expect(err.path).toBe(path.join('.'));
      expect(err.message).toContain(path.join('.'));
      expect(JSON.stringify(tree, null, 2)).toBe(RAW);
    },
  );

  it('rejects removals off the allowlist too', () => {
    const err = rejected(fixtureTree(), del(['mcp', 'example-server']));
    expect(err.code).toBe('off_allowlist');
    expect(err.path).toBe('mcp.example-server');
  });

  it('rejects prototype-polluting segments as off-allowlist', () => {
    for (const path of [
      ['__proto__', 'polluted'],
      ['provider', '__proto__', 'name'],
      ['provider', 'nan', 'models', '__proto__'],
      ['constructor', 'prototype'],
    ]) {
      const err = rejected(fixtureTree(), set(path, 'x'));
      expect(err.code, `path: ${path.join('.')}`).toBe('off_allowlist');
    }
  });

  it('rejects structurally invalid ops with code bad_op', () => {
    const tree = fixtureTree();
    const badOps: PatchOp[] = [
      { path: [], value: 'x' },
      { path: ['provider', '', 'name'], value: 'x' },
      { path: ['provider', 'nan', 'name'] },
      { path: ['provider', 'nan', 'name'], value: 'x', remove: true },
    ];
    for (const op of badOps) {
      let err: unknown;
      try {
        patch(tree, [op]);
      } catch (e) {
        err = e;
      }
      expect(err, `op: ${JSON.stringify(op)}`).toBeInstanceOf(PatchError);
      expect((err as PatchError).code, `op: ${JSON.stringify(op)}`).toBe(
        'bad_op',
      );
    }
    expect(JSON.stringify(tree, null, 2)).toBe(RAW);
  });

  it('rejects a mixed batch atomically and the session can still save allowlisted edits', () => {
    const tree = fixtureTree();
    let err: PatchError | undefined;
    try {
      patch(tree, [
        set(['provider', 'nan', 'name'], 'Good edit'),
        set(['mcp', 'example-server', 'enabled'], true),
      ]);
    } catch (e) {
      err = e as PatchError;
    }
    expect(err).toBeInstanceOf(PatchError);
    expect(err?.code).toBe('off_allowlist');
    expect(err?.path).toBe('mcp.example-server.enabled');
    expect(err?.opIndex).toBe(1);
    expect(JSON.stringify(tree, null, 2)).toBe(RAW);
    // "allowlisted changes in the same session still save" (SCW-7 scenario).
    expect(
      patch(tree, [set(['provider', 'nan', 'name'], 'Good edit')]).applied,
    ).toBe(1);
  });
});

// --- orchestration-v2 D1 / SCW-7 set-only row (WU-A 1.1 RED) ---------------
const ins = (path: string[], value: unknown): PatchOp => ({
  path,
  value,
  insert: true,
});

describe('patch — set-only agent.<name> whole-entry row (SCW-7, D1)', () => {
  it('accepts a length-2 agent value op ONLY with insert===true (create)', () => {
    const tree = fixtureTree();
    const entry = { description: 'helper', prompt: 'do the thing' };
    const out = patch(tree, [ins(['agent', 'my-helper'], entry)]).tree
      .agent as Record<string, unknown>;
    expect(out['my-helper']).toEqual(entry);
    // Inserted values are cloned — caller objects never alias into the tree.
    expect(out['my-helper']).not.toBe(entry);
  });

  it('rejects bare value and remove on agent.<name> with off_allowlist', () => {
    const tree = fixtureTree();
    // Silent update (no insert flag) — the models.ts overwrite pattern D1 forbids.
    const bare = rejected(tree, set(['agent', 'sdd-spec'], { prompt: 'x' }));
    expect(bare.code).toBe('off_allowlist');
    expect(bare.path).toBe('agent.sdd-spec');
    // Never delete: remove is off the allowlist on the whole-entry row.
    const rm = rejected(tree, del(['agent', 'sdd-spec']));
    expect(rm.code).toBe('off_allowlist');
    expect(rm.path).toBe('agent.sdd-spec');
    expect(JSON.stringify(tree, null, 2)).toBe(RAW);
  });

  it('insert over an existing entry throws PatchError code "exists"', () => {
    const err = rejected(
      fixtureTree(),
      ins(['agent', 'sdd-spec'], { prompt: 'x' }),
    );
    expect(err.code).toBe('exists');
    expect(err.path).toBe('agent.sdd-spec');
  });

  it('isId backstops prototype-pollution names on the set-only row', () => {
    const tree = fixtureTree();
    for (const name of ['__proto__', 'constructor', 'prototype']) {
      const err = rejected(tree, ins(['agent', name], { prompt: 'x' }));
      expect(err.code, `name: ${name}`).toBe('off_allowlist');
    }
    expect(JSON.stringify(tree, null, 2)).toBe(RAW);
  });
});

describe('patch — structural sharing (design: untouched subtrees keep same references)', () => {
  it('path-copies only the mutated chain and deep-clones inserted values', () => {
    const orig = fixtureTree();
    const value = { name: 'V', meta: { n: 1 } };
    const { tree: out } = patch(orig, [
      set(['provider', 'nan', 'name'], 'X'),
      set(['provider', 'headroom', 'models', 'm1'], value),
    ]);
    value.meta.n = 99; // must not leak into the tree (structuredClone)

    expect(out).not.toBe(orig);
    const op = providers(orig);
    const np = providers(out);
    expect(np).not.toBe(op);
    expect(np.nan).not.toBe(op.nan);
    // Mutated providers' untouched subtrees: same references, no rebuild.
    expect(np.nan.models).toBe(op.nan.models);
    expect(np.nan.options).toBe(op.nan.options); // only `name` mutated on nan
    expect(np.headroom.options).toBe(op.headroom.options);
    expect(np.headroom).not.toBe(op.headroom); // headroom.models was added to
    expect(np.nanSendvalu).toBe(op.nanSendvalu);
    expect(out.agent).toBe(orig.agent);
    expect(out.mcp).toBe(orig.mcp);
    expect(out.compaction).toBe(orig.compaction);
    expect(out.instructions).toBe(orig.instructions);
    expect(out.share).toBe(orig.share);
    expect(out.custom).toBe(orig.custom);
    expect(
      (providers(out).headroom.models as Record<string, ConfigTree>).m1,
    ).toEqual({
      name: 'V',
      meta: { n: 1 },
    });
  });
});

// --- agent-pipelines WU-1 task 1.5 (RED) — SCW-7' four widenings ------------
// New confinement rows: whole-value `agent-pipelines` write, per-entry
// definition remove, user-owned whole-entry DELETE and user-owned prompt
// value-op — with ownership enforcement in the ACCUMULATED-TREE loop
// (def-map ops ordered before row ops make the pipeline-delete batch pass;
// every other batch on a member throws pipeline_owned naming the owner).
describe("patch — agent-pipelines section rows (SCW-7' a)", () => {
  const defMap = {
    mypl: {
      roles: [
        {
          name: 'mypl-build',
          description: 'd',
          promptSource: 'template',
          prompt: 'p',
        },
      ],
      orchestrator: { description: 'd' },
    },
  };

  it('admits the whole-value agent-pipelines write and the per-entry remove', () => {
    const out = patch(fixtureTree(), [
      set(['agent-pipelines'], defMap),
      del(['agent-pipelines', 'mypl']),
    ]);
    expect(out.applied).toBe(2);
    expect(out.tree['agent-pipelines']).toEqual({});
  });

  it('rejects whole-MAP removal, per-entry def writes and off-list generated fields', () => {
    const tree = fixtureTree();
    expect(rejected(tree, del(['agent-pipelines'])).code).toBe('off_allowlist');
    expect(
      rejected(tree, set(['agent-pipelines', 'mypl'], defMap.mypl)).code,
    ).toBe('off_allowlist');
    for (const field of ['mode', 'hidden', 'permission']) {
      expect(
        rejected(tree, set(['agent', 'my-helper', field], 'nope')).code,
        field,
      ).toBe('off_allowlist');
    }
    for (const name of ['__proto__', '..', 'constructor']) {
      expect(rejected(tree, del(['agent-pipelines', name])).code, name).toBe(
        'off_allowlist',
      );
    }
    expect(JSON.stringify(tree, null, 2)).toBe(RAW);
  });
});

describe('patch — accumulated-tree ownership gates (SCW-7 b/d, AP-4)', () => {
  const treeWithPipeline = (): ConfigTree => ({
    agent: {
      mypl: { mode: 'primary', prompt: 'orch', description: 'd' },
      'mypl-build': { mode: 'subagent', hidden: true, prompt: 'p' },
      'free-agent': { prompt: 'keep' },
    },
    'agent-pipelines': {
      mypl: {
        roles: [
          {
            name: 'mypl-build',
            description: 'd',
            promptSource: 'template',
            prompt: 'p',
          },
        ],
        orchestrator: { description: 'd' },
      },
    },
  });

  it('member via standalone remove → pipeline_owned naming the owner', () => {
    const err = rejected(treeWithPipeline(), del(['agent', 'mypl-build']));
    expect(err.code).toBe('pipeline_owned');
    expect(err.message).toContain('mypl');
  });

  it('def-map-minus-entry FIRST, then removes → the delete batch passes in order', () => {
    const tree = treeWithPipeline();
    const out = patch(tree, [
      set(['agent-pipelines'], {}),
      del(['agent', 'mypl']),
      del(['agent', 'mypl-build']),
    ]);
    expect(out.applied).toBe(3);
    expect(Object.keys(out.tree.agent as object)).toEqual(['free-agent']);
    expect(JSON.stringify(tree.agent)).toContain('mypl-build'); // input intact
  });

  it('builder rewrite pair (remove+insert, same path) passes mid-batch', () => {
    const out = patch(treeWithPipeline(), [
      del(['agent', 'mypl-build']),
      ins(['agent', 'mypl-build'], {
        mode: 'subagent',
        hidden: true,
        prompt: 'regenerated',
      }),
    ]).tree;
    expect((out.agent as Record<string, ConfigTree>)['mypl-build'].prompt).toBe(
      'regenerated',
    );
  });

  it('generic value paths on members rejected; user-owned untouched (AP-4, SCW-7 b)', () => {
    const tree = treeWithPipeline();
    const err = rejected(tree, set(['agent', 'mypl-build', 'model'], 'x'));
    expect(err.code).toBe('pipeline_owned');
    expect(err.message).toContain('mypl');
    const ok = patch(tree, [
      set(['agent', 'free-agent', 'description'], 'fine'),
      set(['agent', 'free-agent', 'prompt'], 'user-owned text'),
    ]);
    expect(ok.applied).toBe(2);
  });

  it('prompt row gated to user-owned (SCW-7 c): reserved rejected, absent leaf remove inert', () => {
    const tree = fixtureTree();
    expect(rejected(tree, set(['agent', 'sdd-spec', 'prompt'], 'x')).code).toBe(
      'off_allowlist',
    );
    const ok = patch(tree, [
      ins(['agent', 'my-helper'], { prompt: 'created' }),
      set(['agent', 'my-helper', 'prompt'], 'user-owned text'),
      del(['agent', 'ghost-of-agent-past']),
    ]);
    expect(ok.applied).toBe(3);
    expect(
      (ok.tree.agent as Record<string, ConfigTree>)['my-helper'].prompt,
    ).toBe('user-owned text');
  });
});
