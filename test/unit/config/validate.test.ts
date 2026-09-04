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
