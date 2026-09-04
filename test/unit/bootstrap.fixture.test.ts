// WU1.4 — harness smoke test: the synthetic fixture parses and is a
// byte-exact JSON.stringify(tree, null, 2) round-trip (SCW-6 precondition:
// key order + 2-space serialization contract). Tests never touch the real
// ~/.config/opencode/opencode.json — only this fixture (sandbox rule).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const FIXTURE_PATH = fileURLToPath(
  new URL('../fixtures/config.sample.json', import.meta.url),
);
const raw = readFileSync(FIXTURE_PATH, 'utf8');
const tree = JSON.parse(raw) as Record<string, unknown>;

describe('synthetic fixture (test/fixtures/config.sample.json)', () => {
  it('round-trips byte-identically through JSON.stringify(tree, null, 2)', () => {
    expect(JSON.stringify(tree, null, 2)).toBe(raw);
    expect(raw.endsWith('\n')).toBe(false);
  });

  it('preserves top-level key order, including unknown keys', () => {
    expect(Object.keys(tree)).toEqual([
      '$schema',
      'provider',
      'default_agent',
      'agent',
      'compaction',
      'instructions',
      'mcp',
      'share',
      'custom',
    ]);
  });

  it('carries the shapes later work units depend on', () => {
    const provider = tree.provider as Record<string, Record<string, unknown>>;
    expect(Object.keys(provider)).toEqual(['nan', 'headroom', 'nanSendvalu']);
    // one inline apiKey placeholder, one absent, one empty-string
    const nanOptions = provider.nan?.options as Record<string, unknown>;
    expect(typeof nanOptions?.apiKey).toBe('string');
    expect(nanOptions?.apiKey).toContain('synthetic');
    const headroomOptions = provider.headroom?.options as Record<
      string,
      unknown
    >;
    expect('apiKey' in headroomOptions).toBe(false);
    // one provider with an empty model list
    expect(provider.headroom?.models).toEqual({});
    // known-drift contextWindow case (declared 1M vs snapshot 262K, MC-5)
    const nanModels = provider.nan?.models as Record<
      string,
      Record<string, unknown>
    >;
    expect(nanModels['qwen3.8-flash']?.contextWindow).toBe(1000000);
    expect(nanModels['glm5.3-flash']?.contextWindow).toBe(262144);
    // agents: mix of set / unset model and description-only entries (OA-1)
    const agent = tree.agent as Record<string, Record<string, unknown>>;
    expect(Object.keys(agent)).toHaveLength(6);
    expect(agent['sdd-spec-deep']).toEqual({});
  });
});
