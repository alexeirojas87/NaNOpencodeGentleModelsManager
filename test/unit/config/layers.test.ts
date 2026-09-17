// Higher-precedence layer detection contract. `detectOverrides` is PURE:
// every existence question runs through the injected pathExists, so these
// cases NEVER touch the real filesystem (no temp dirs, no ~/.config).
import { describe, expect, it } from 'vitest';

import { detectOverrides } from '../../../server/src/config/layers';

describe('detectOverrides — OPENCODE_CONFIG_DIR (config_dir_env)', () => {
  it('reports the layer config file path when one exists inside the dir', () => {
    const out = detectOverrides(
      { OPENCODE_CONFIG_DIR: '/layers/override' },
      '/managed/opencode.json',
      { pathExists: (p) => p === '/layers/override/opencode.json' },
    );
    expect(out).toEqual([
      {
        kind: 'config_dir_env',
        path: '/layers/override/opencode.json',
        reason: expect.stringContaining('OPENCODE_CONFIG_DIR'),
      },
    ]);
  });

  it('prefers opencode.json over opencode.jsonc when both exist', () => {
    const out = detectOverrides(
      { OPENCODE_CONFIG_DIR: '/layers/override' },
      '/managed/opencode.json',
      { pathExists: () => true },
    );
    expect(out[0]?.path).toBe('/layers/override/opencode.json');
  });

  it('falls back to the directory path when no config file exists inside', () => {
    const out = detectOverrides(
      { OPENCODE_CONFIG_DIR: '/layers/override' },
      '/managed/opencode.json',
      { pathExists: () => false },
    );
    expect(out).toEqual([
      {
        kind: 'config_dir_env',
        path: '/layers/override',
        reason: expect.stringContaining('OPENCODE_CONFIG_DIR'),
      },
    ]);
  });

  it('is not an override when it points at the managed directory', () => {
    // pathExists is false throughout so only the dir-equality guard is under
    // test: a trailing slash must still compare equal to the managed dir.
    const out = detectOverrides(
      { OPENCODE_CONFIG_DIR: '/managed/' },
      '/managed/opencode.json',
      { pathExists: () => false },
    );
    expect(out).toEqual([]);
  });

  it('ignores absent and blank/whitespace values', () => {
    const missingDir = { OPENCODE_CONFIG_DIR: undefined };
    const blank = { OPENCODE_CONFIG_DIR: '   ' };
    expect(detectOverrides(missingDir, '/managed/opencode.json')).toEqual([]);
    expect(detectOverrides(blank, '/managed/opencode.json')).toEqual([]);
  });
});

describe('detectOverrides — opencode.jsonc sibling (jsonc_sibling)', () => {
  it('reports an existing sibling next to the managed opencode.json', () => {
    const out = detectOverrides({}, '/managed/opencode.json', {
      pathExists: (p) => p === '/managed/opencode.jsonc',
    });
    expect(out).toEqual([
      {
        kind: 'jsonc_sibling',
        path: '/managed/opencode.jsonc',
        reason: expect.stringContaining('opencode.jsonc'),
      },
    ]);
  });

  it('ignores an absent sibling', () => {
    expect(
      detectOverrides({}, '/managed/opencode.json', {
        pathExists: () => false,
      }),
    ).toEqual([]);
  });

  it('does not treat a jsonc sibling of a differently named managed file as an override', () => {
    expect(
      detectOverrides({}, '/managed/custom.json', { pathExists: () => true }),
    ).toEqual([]);
  });
});

describe('detectOverrides — deterministic order and safety', () => {
  it('orders config_dir_env before jsonc_sibling', () => {
    const out = detectOverrides(
      { OPENCODE_CONFIG_DIR: '/layers/override' },
      '/managed/opencode.json',
      { pathExists: () => true },
    );
    expect(out.map((o) => o.kind)).toEqual(['config_dir_env', 'jsonc_sibling']);
  });

  it('never throws on empty or malformed inputs', () => {
    expect(detectOverrides({}, '')).toEqual([]);
    expect(
      detectOverrides({ OPENCODE_CONFIG_DIR: '' }, '/managed/opencode.json'),
    ).toEqual([]);
  });
});
