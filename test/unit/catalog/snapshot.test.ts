// WU7.1/7.2 (RED) — unit tests for the bundled NaN catalog snapshot and the
// drift oracle (spec §Snapshot definition, MC-3..MC-5, PC-4, CX-4).
// Binding behavior:
//   • the snapshot ships OFFLINE with the app: asOf + provider match metadata
//     + per-model docs metadata/quotas, and NO pricing (spec Definitions);
//   • drift cells compare a declared model's contextWindow against the
//     snapshot value — advisory only: pure read, never rewrites, never
//     blocks (MC-5; the save pipeline is not involved here at all);
//   • provider matching is keyed by the snapshot's npm+name metadata, NEVER
//     by a provider id — generic over 0..N providers (PC-4).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  computeDrift,
  nanSnapshot,
  providerMatchesSnapshot,
} from '../../../server/src/catalog';
import type { CatalogResponse, ConfigTree } from '../../../shared/types';

const FIXTURE_PATH = fileURLToPath(
  new URL('../../fixtures/config.sample.json', import.meta.url),
);

/** Providers under test carry the snapshot's own npm+name unless stated. */
const SNAP_PROVIDER = {
  npm: '@ai-sdk/openai-compatible',
  name: 'NaN',
};

function fakeSnapshot(
  models: Record<string, { contextWindow?: number }>,
): CatalogResponse {
  return {
    asOf: '2000-01-01',
    provider: { ...SNAP_PROVIDER },
    models,
  };
}

function treeWithProvider(
  entry: Record<string, unknown>,
  id = 'anything',
): ConfigTree {
  return { provider: { [id]: entry } };
}

/** Recursive key scan — pricing must be structurally absent (keys, not values). */
function keysMatching(
  value: unknown,
  re: RegExp,
  out: string[] = [],
): string[] {
  if (Array.isArray(value)) {
    for (const item of value) keysMatching(item, re, out);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (re.test(key)) out.push(key);
      keysMatching(child, re, out);
    }
  }
  return out;
}

describe('bundled snapshot (7.1, CX-4)', () => {
  it('ships with a real asOf date and npm+name provider metadata', () => {
    expect(nanSnapshot.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(nanSnapshot.provider.npm).toBe(SNAP_PROVIDER.npm);
    expect(nanSnapshot.provider.name).toBe(SNAP_PROVIDER.name);
    // The document itself must NOT be keyed by a CONFIG provider id.
    expect(Object.keys(nanSnapshot).sort()).toEqual([
      'asOf',
      'models',
      'provenance',
      'provider',
    ]);
  });

  it('contains no pricing anywhere — the docs publish quotas, not prices', () => {
    expect(keysMatching(nanSnapshot, /price|pricing|cost|charge/i)).toEqual([]);
  });

  it('records a numeric context quota plus docs label for every catalog model', () => {
    const ids = Object.keys(nanSnapshot.models);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const entry = nanSnapshot.models[id];
      expect(typeof entry.contextWindow).toBe('number');
      expect(Number.isFinite(entry.contextWindow)).toBe(true);
      expect(typeof entry.contextDocs).toBe('string');
      expect(String(entry.contextDocs).length).toBeGreaterThan(0);
    }
    // The MC-5 precedent entry and the MC-3 pre-fill entry are present.
    expect(nanSnapshot.models['qwen3.8-flash'].contextWindow).toBe(262144);
    expect(nanSnapshot.models['glm5.3-flash']).toBeDefined();
  });

  it('documents its provenance honestly (source + transcription method)', () => {
    const provenance = nanSnapshot.provenance;
    expect(provenance).toBeDefined();
    expect(String(provenance?.source)).toContain('docs');
    expect(String(provenance?.method).length).toBeGreaterThan(20);
  });
});

describe('providerMatchesSnapshot (PC-4 — metadata, never the id)', () => {
  it('matches by npm + name regardless of the CONFIG provider id', () => {
    expect(
      providerMatchesSnapshot({ ...SNAP_PROVIDER, models: {} }, 'zzz-weird'),
    ).toBe(true);
  });

  it('rejects a different npm package (no drift data for other providers)', () => {
    expect(
      providerMatchesSnapshot(
        { npm: '@ai-sdk/anthropic', name: 'NaN' },
        'anything',
      ),
    ).toBe(false);
  });

  it('rejects same npm with a different name (the nanSendvalu case)', () => {
    expect(
      providerMatchesSnapshot(
        { npm: SNAP_PROVIDER.npm, name: 'NaN Sendvalu' },
        'nanSendvalu',
      ),
    ).toBe(false);
  });

  it('is safe on garbage: non-objects and missing metadata never match', () => {
    expect(providerMatchesSnapshot(undefined, 'x')).toBe(false);
    expect(providerMatchesSnapshot('nope', 'x')).toBe(false);
    expect(providerMatchesSnapshot({ name: 'NaN' }, 'x')).toBe(false);
    expect(providerMatchesSnapshot({ npm: SNAP_PROVIDER.npm }, 'x')).toBe(
      false,
    );
  });
});

describe('computeDrift (MC-5 rules, advisory only)', () => {
  const snap = fakeSnapshot({
    drifted: { contextWindow: 262144 },
    aligned: { contextWindow: 262144 },
  });

  it('declared 1M vs snapshot 262K → exactly one advisory cell', () => {
    const tree = treeWithProvider({
      ...SNAP_PROVIDER,
      models: { drifted: { contextWindow: 1000000 } },
    });
    expect(computeDrift(tree, snap)).toEqual([
      {
        provider: 'anything',
        model: 'drifted',
        field: 'contextWindow',
        declared: 1000000,
        snapshot: 262144,
        advisory: true,
      },
    ]);
  });

  it('aligned declarations, absent fields and unknown models produce no cells', () => {
    const tree = treeWithProvider({
      ...SNAP_PROVIDER,
      models: {
        aligned: { contextWindow: 262144 },
        drifted: { name: 'no contextWindow declared' },
        'not-in-snapshot': { contextWindow: 123 },
      },
    });
    expect(computeDrift(tree, snap)).toEqual([]);
  });

  it('non-matching providers get ZERO drift data (generic 0..N)', () => {
    const tree: ConfigTree = {
      provider: {
        other: {
          npm: '@ai-sdk/anthropic',
          name: 'Other',
          models: { drifted: { contextWindow: 999 } },
        },
        matchA: {
          ...SNAP_PROVIDER,
          models: { drifted: { contextWindow: 1000000 } },
        },
      },
    };
    const cells = computeDrift(tree, snap);
    expect(cells.map((c) => c.provider)).toEqual(['matchA']);
  });

  it('walks every provider and model in declaration order', () => {
    const tree: ConfigTree = {
      provider: {
        first: {
          ...SNAP_PROVIDER,
          models: {
            'b-model': { contextWindow: 1 },
            'a-model': { contextWindow: 2 },
          },
        },
        second: {
          ...SNAP_PROVIDER,
          models: { drifted: { contextWindow: 3 } },
        },
      },
    };
    const snapWide = fakeSnapshot({
      'a-model': { contextWindow: 100 },
      'b-model': { contextWindow: 100 },
      drifted: { contextWindow: 100 },
    });
    expect(
      computeDrift(tree, snapWide).map((c) => `${c.provider}/${c.model}`),
    ).toEqual(['first/b-model', 'first/a-model', 'second/drifted']);
  });

  it('is a pure read — never mutates the tree it inspects', () => {
    const tree = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as ConfigTree;
    const before = structuredClone(tree);
    computeDrift(tree);
    expect(tree).toEqual(before);
  });

  it('fixture golden: exactly the 5 drifted nan cells; aligned qwen3.6 has none', () => {
    const tree = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as ConfigTree;
    expect(computeDrift(tree)).toEqual([
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
    ]);
    // Defensive: the aligned qwen3.6 (declared == snapshot) is absent, and
    // non-matching providers (headroom, nanSendvalu) contribute nothing.
    expect(
      computeDrift(tree).some(
        (c) =>
          c.model === 'qwen3.6' ||
          c.provider === 'headroom' ||
          c.provider === 'nanSendvalu',
      ),
    ).toBe(false);
  });
});
