// WU3.3 (RED, companion) — validate(): permissive generated schema (task 3.1
// verification item: unknown top-level keys AND unknown ModelConfig keys are
// never rejected — CX-4/SCW-7) plus the domain addendum that gives readable
// per-path errors for spec ModelConfig fields upstream doesn't declare
// (SCW-3: contextWindow "1M" must name the offending key path). Schema
// policing is scoped to the writable sections (provider/agent/default_agent);
// externally owned subtrees are passthrough by SCW-7 and never policed.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { ConfigTree } from '../../../server/src/config/load';
import { validate } from '../../../server/src/config/validate';

const FIXTURE_PATH = fileURLToPath(
  new URL('../../fixtures/config.sample.json', import.meta.url),
);
const fixtureTree = (): ConfigTree =>
  JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as ConfigTree;

function models(tree: ConfigTree, id: string): Record<string, ConfigTree> {
  return (tree.provider as Record<string, ConfigTree>)[id].models as Record<
    string,
    ConfigTree
  >;
}

describe('validate — permissive passthrough (task 3.1 verification, CX-4)', () => {
  it('accepts the full fixture, including unknown top-level keys', () => {
    // Fixture carries $schema/compaction/instructions/mcp/share/custom.
    expect(validate(fixtureTree())).toEqual([]);
  });

  it('accepts unknown ModelConfig keys (upstream never declares contextWindow)', () => {
    const tree = fixtureTree();
    const qwen = models(tree, 'nan')['qwen3.6'];
    qwen.contextWindow = 262144; // spec superset field, unknown upstream
    qwen.someFutureField = { deep: [1, 'two', null] };
    expect(validate(tree)).toEqual([]);
  });

  it('accepts unknown provider options keys and minimal/empty trees', () => {
    expect(validate({})).toEqual([]);
    expect(
      validate({
        provider: {
          p: { options: { apiKey: 'k', customOpt: { a: 1 } }, models: {} },
        },
      }),
    ).toEqual([]);
  });

  it('never polices values outside the writable sections (ownership rule)', () => {
    // compaction.reserved is number upstream; the fixture carries a string.
    // Externally owned drift must not block an allowlisted save — those keys
    // survive untouched either way (SCW-7).
    expect(
      validate({
        compaction: { reserved: 'not-a-number' },
        mcp: { s: { command: 42 } },
        provider: {},
      }),
    ).toEqual([]);
  });
});

describe('validate — readable per-path errors (SCW-3)', () => {
  it('blocks contextWindow "1M" naming the key path', () => {
    const tree = fixtureTree();
    models(tree, 'nan')['qwen3.8-flash'].contextWindow = '1M';

    const issues = validate(tree);
    const hit = issues.find(
      (i) => i.path === 'provider.nan.models.qwen3.8-flash.contextWindow',
    );
    expect(hit).toBeDefined();
    expect(hit?.message.toLowerCase()).toContain('number');
  });

  it('reports wrong types on upstream-declared fields with one issue per path', () => {
    const tree = fixtureTree();
    (tree.provider as Record<string, ConfigTree>).nan.name = 42;
    (tree.agent as Record<string, ConfigTree>)['jd-judge-a'].temperature =
      'hot';
    (
      (tree.provider as Record<string, ConfigTree>).nan.options as ConfigTree
    ).apiKey = 42;

    const issues = validate(tree);
    const paths = issues.map((i) => i.path);
    expect(paths).toContain('provider.nan.name');
    expect(paths).toContain('agent.jd-judge-a.temperature');
    expect(paths).toContain('provider.nan.options.apiKey');
    for (const issue of issues) {
      expect(issue.path).not.toBe('');
      expect(issue.message.length).toBeGreaterThan(0);
    }
  });
});

// --- agent-pipelines WU-1 task 1.3 (RED) — AP-1 strict definition schema ----
// `agent-pipelines` joins the policed writable sections: unknown fields are
// NAMED with their path (no-unrecognized-keys), `{file:` is an ANCHORED gate
// (mid-string survives as inert text, OA-4'), and prompts cap at 64 KiB.
// Other top-level keys stay permissive passthrough (C-R2 — proven by the
// fixture-acceptance test above).
describe('validate — agentPipelinesSchema AP-1 strict shape', () => {
  const role = {
    name: 'mypl-build',
    description: 'Build it',
    promptSource: 'template',
    prompt: 'Do the build task.',
  };
  const def = {
    roles: [role],
    orchestrator: { description: 'coordinate mypl' },
  };
  const withPipelines = (pipelines: unknown): ConfigTree => ({
    provider: {},
    'agent-pipelines': pipelines as ConfigTree['agent-pipelines'],
  });

  it('accepts a valid definition, incl. optional model/helpers', () => {
    expect(validate(withPipelines({ mypl: def }))).toEqual([]);
    expect(
      validate(
        withPipelines({
          mypl: {
            roles: [{ ...role, model: 'nan/glm5.3-flash' }],
            orchestrator: { model: 'nan/qwen3.8-flash', description: 'd' },
            helpers: ['general'],
          },
        }),
      ),
    ).toEqual([]);
  });

  it('names the path of an unknown field (no-unrecognized-keys)', () => {
    const issues = validate(
      withPipelines({ mypl: { ...def, temperature: 0.2 } }),
    );
    expect(issues.some((i) => i.path.includes('agent-pipelines.mypl'))).toBe(
      true,
    );
    expect(issues.some((i) => i.message.includes('temperature'))).toBe(true);

    const roleIssues = validate(
      withPipelines({
        mypl: { ...def, roles: [{ ...role, mode: 'subagent' }] },
      }),
    );
    expect(
      roleIssues.some(
        (i) => i.path.includes('roles.0') && i.message.includes('mode'),
      ),
    ).toBe(true);
  });

  it('rejects whole-string {file:} prompts but keeps mid-string {file: text (anchored)', () => {
    const ref = validate(
      withPipelines({
        mypl: { ...def, roles: [{ ...role, prompt: '{file:./x.md}' }] },
      }),
    );
    expect(ref.length).toBeGreaterThan(0);
    expect(ref[0]?.path).toContain('agent-pipelines.mypl.roles.0.prompt');

    const mid = validate(
      withPipelines({
        mypl: {
          ...def,
          roles: [{ ...role, prompt: 'context {file:x} stays inert text' }],
        },
      }),
    );
    expect(mid).toEqual([]);
  });

  it('rejects >64 KiB prompts and empty prompts; bad enum promptSource named', () => {
    const big = validate(
      withPipelines({
        mypl: { ...def, roles: [{ ...role, prompt: 'x'.repeat(65 * 1024) }] },
      }),
    );
    expect(big.length).toBeGreaterThan(0);
    const empty = validate(
      withPipelines({ mypl: { ...def, roles: [{ ...role, prompt: '' }] } }),
    );
    expect(empty.length).toBeGreaterThan(0);
    const src = validate(
      withPipelines({
        mypl: { ...def, roles: [{ ...role, promptSource: 'paste' }] },
      }),
    );
    expect(src.some((i) => i.path.includes('roles.0.promptSource'))).toBe(true);
  });

  it('rejects hostile pipeline keys and helper glob metas (task-map keys)', () => {
    for (const key of ['bad name', '*', '..']) {
      expect(
        validate(withPipelines({ [key]: def })).length,
        `key: ${key}`,
      ).toBeGreaterThan(0);
    }
    const helper = validate(
      withPipelines({ mypl: { ...def, helpers: ['*'] } }),
    );
    expect(helper.length).toBeGreaterThan(0);
  });
});
