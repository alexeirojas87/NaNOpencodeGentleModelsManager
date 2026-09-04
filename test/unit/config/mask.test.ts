// WU2.1 (RED) — maskConfig contract (PC-2 data, CX-2).
// The apiKey VALUE must never appear anywhere in the masked output; only a
// {configured:boolean} presence indicator replaces it. Input tree is never
// mutated (server keeps the verbatim value in memory for pass-through PC-3).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { ConfigTree } from '../../../server/src/config/load';
import { maskConfig } from '../../../server/src/config/mask';

const FIXTURE_PATH = fileURLToPath(
  new URL('../../fixtures/config.sample.json', import.meta.url),
);
const RAW = readFileSync(FIXTURE_PATH, 'utf8');
const TREE = JSON.parse(RAW) as ConfigTree;

const NAN_KEY = 'sk-synthetic-nan-placeholder-do-not-use';

function options(
  tree: ConfigTree,
  providerId: string,
): Record<string, unknown> | undefined {
  const provider = tree.provider as Record<string, ConfigTree> | undefined;
  return provider?.[providerId]?.options as Record<string, unknown> | undefined;
}

describe('maskConfig — presence indicator replaces apiKey value (PC-2, CX-2)', () => {
  it('sets configured=true for a non-empty apiKey and copies the value nowhere', () => {
    const masked = maskConfig(TREE);

    expect(options(masked, 'nan')?.apiKey).toEqual({ configured: true });
    // The secret value appears nowhere in the masked tree — not as a value,
    // not as a key, not nested (full serialization check per CX-2).
    const serialized = JSON.stringify(masked);
    expect(serialized).not.toContain(NAN_KEY);
  });

  it('sets configured=false for an explicitly empty apiKey string', () => {
    const masked = maskConfig(TREE);
    expect(options(masked, 'nanSendvalu')?.apiKey).toEqual({
      configured: false,
    });
  });

  it('does not invent an apiKey key for providers that have none', () => {
    const masked = maskConfig(TREE);
    const headroomOptions = options(masked, 'headroom');
    expect(headroomOptions).toBeDefined();
    expect('apiKey' in (headroomOptions as object)).toBe(false);
  });

  it('treats a non-string apiKey value as not configured, dropping the value', () => {
    const weird: ConfigTree = {
      provider: {
        odd: { options: { baseURL: 'https://x.example', apiKey: 42 } },
      },
    };
    const masked = maskConfig(weird);
    expect(options(masked, 'odd')?.apiKey).toEqual({ configured: false });
    expect(JSON.stringify(masked)).not.toContain('42');
  });
});

describe('maskConfig — purity and structure preservation', () => {
  it('never mutates the input tree; the server copy keeps the verbatim key', () => {
    const tree = JSON.parse(RAW) as ConfigTree;
    const masked = maskConfig(tree);

    // Input unchanged (pass-through source of truth for PC-3).
    expect(options(tree, 'nan')?.apiKey).toBe(NAN_KEY);
    expect(JSON.stringify(tree, null, 2)).toBe(RAW);
    // Masked output is a structurally independent clone.
    expect(masked).not.toBe(tree);
    expect(options(masked, 'nan')).not.toBe(options(tree, 'nan'));
  });

  it('preserves key order and everything outside provider.*.options.apiKey', () => {
    const masked = maskConfig(TREE);

    expect(Object.keys(masked)).toEqual(Object.keys(TREE));
    const providerIds = (TREE.provider as Record<string, unknown>) ?? {};
    expect(Object.keys(masked.provider as object)).toEqual(
      Object.keys(providerIds),
    );
    // models subtree survives deep-equal (MC-1 data flows through masking).
    expect((masked.provider as Record<string, ConfigTree>).nan?.models).toEqual(
      (TREE.provider as Record<string, ConfigTree>).nan?.models,
    );
    // unknown top-level keys pass through untouched (SCW-7 data).
    expect(masked.custom).toEqual(TREE.custom);
    expect(masked.mcp).toEqual(TREE.mcp);
    expect(masked.agent).toEqual(TREE.agent);
    expect(masked.default_agent).toEqual(TREE.default_agent);
  });

  it('is generic over 0..N providers with no hardcoded ids (PC-4)', () => {
    const many: ConfigTree = {
      provider: Object.fromEntries(
        Array.from({ length: 5 }, (_, i) => [
          `p${i}`,
          { options: { apiKey: i % 2 === 0 ? `secret-${i}` : '' } },
        ]),
      ),
    };
    const masked = maskConfig(many);
    const providers = masked.provider as Record<string, ConfigTree>;

    expect(Object.keys(providers)).toHaveLength(5);
    expect((providers.p0?.options as ConfigTree).apiKey).toEqual({
      configured: true,
    });
    expect((providers.p1?.options as ConfigTree).apiKey).toEqual({
      configured: false,
    });
    const serialized = JSON.stringify(masked);
    for (let i = 0; i < 5; i += 1) {
      expect(serialized).not.toContain(`secret-${i}`);
    }
  });

  it('tolerates malformed provider shapes without throwing', () => {
    const malformed: ConfigTree = {
      provider: { broken: 'not-an-object', noOptions: { name: 'x' } },
    };
    const masked = maskConfig(malformed);
    expect((masked.provider as Record<string, unknown>).broken).toBe(
      'not-an-object',
    );
    expect((masked.provider as Record<string, unknown>).noOptions).toEqual({
      name: 'x',
    });
  });
});
