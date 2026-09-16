// agent-pipelines WU-1 task 1.1 (RED) — ownership predicate (AP-6, AC-3) and
// the blocklist parity table: the AC-3 surface MUST stay ⊇ the C-G4 reserved
// set at every pin bump (AP-8). 23 base keys enumerated from gentle-ai's
// sdd-overlay-multi.json at research pin d4518aae, re-cited at head
// 9c73c731 (WU-0: blob-identical). isUserOwned = ¬isReserved; pipeline
// detection reads the CONFIG `agent-pipelines` definition map tolerantly.
// phase-agents-v3 tasks 1.8/1.9 — version-gated v3 predicate truth table:
// the 13 exact roster names become user-owned ONLY at 3.x; every legacy
// family stays reserved at EVERY version; 2.x/unknown ≡ legacy behavior.
// Pure unit — no fs, sandbox rule N/A.
import { describe, expect, it } from 'vitest';

import type { ConfigTree } from '../../../server/src/config/load';
import {
  findPipelineOwner,
  isPipelineOwned,
  isReserved,
  isReservedV3,
  isRosterProtected,
  isUserOwned,
  isUserOwnedV3,
  MAX_PROMPT_BYTES,
  NAME_RE,
  NAME_UNSAFE,
  REF_RE,
} from '../../../server/src/config/ownership';
import { PHASE_AGENT_ROSTER_NAMES } from '../../../shared/roster';

// The C-G4 base set (23 keys) — sync-side managed agents at the pinned head.
const C_G4_BASE = [
  'gentle-orchestrator',
  'general',
  'explore',
  'sdd-init',
  'sdd-explore',
  'sdd-research',
  'sdd-propose',
  'sdd-spec',
  'sdd-design',
  'sdd-tasks',
  'sdd-apply',
  'sdd-verify',
  'sdd-archive',
  'sdd-onboard',
  'jd-judge-a',
  'jd-judge-b',
  'jd-fix-agent',
  'review-risk',
  'review-readability',
  'review-reliability',
  'review-resilience',
  'review-refuter',
  'review-validator',
];

describe('ownership — AC-3 blocklist parity ⊇ C-G4 (AP-8 table test)', () => {
  it.each(C_G4_BASE)('rejects base key %s as reserved', (name) => {
    expect(isReserved(name)).toBe(true);
    expect(isUserOwned(name)).toBe(false);
  });

  it('rejects the suffixed profile forms (sdd-<phase>-P, sdd-orchestrator-P, jd-*-P)', () => {
    for (const name of [
      'sdd-spec-cheap',
      'sdd-orchestrator-deep',
      'jd-judge-a-fast',
      'jd-fix-agent-turbo',
      'review-risk-v2',
    ]) {
      expect(isReserved(name), name).toBe(true);
    }
  });

  it('accepts none of the blocklist as creatable; case-sensitive per spec', () => {
    for (const legal of ['my-helper', 'Explore', 'sdd', 'sddx', 'mypl']) {
      expect(isReserved(legal), legal).toBe(false);
      expect(isUserOwned(legal), legal).toBe(true);
    }
  });

  it('relocates the charset/segment-hostility/anchor gates (1.2 move)', () => {
    expect(NAME_RE.test('my.pl-1_x')).toBe(true);
    expect(NAME_RE.test('bad name')).toBe(false);
    for (const bad of ['.', '..', '__proto__', 'constructor', 'prototype']) {
      expect(NAME_UNSAFE.has(bad), bad).toBe(true);
    }
    expect(REF_RE.test('  {file:./prompts/x.md}  ')).toBe(true); // whole-string
    expect(REF_RE.test('context {file:x} mid-string stays text')).toBe(false);
    expect(MAX_PROMPT_BYTES).toBe(65536);
  });
});

describe('ownership — version-gated v3 predicate (phase-agents-v3, map row 6)', () => {
  const MODES = ['3.x', '2.x', 'unknown'] as const;

  it.each([...PHASE_AGENT_ROSTER_NAMES])(
    'roster name %s is user-owned ONLY at 3.x — reserved at 2.x/unknown',
    (name) => {
      expect(isReservedV3(name, '3.x'), `${name}@3.x`).toBe(false);
      expect(isUserOwnedV3(name, '3.x'), `${name}@3.x`).toBe(true);
      for (const mode of ['2.x', 'unknown'] as const) {
        expect(isReservedV3(name, mode), `${name}@${mode}`).toBe(true);
        expect(isUserOwnedV3(name, mode), `${name}@${mode}`).toBe(false);
      }
    },
  );

  it('legacy variant families stay reserved at EVERY mode (exact-roster carve-out only)', () => {
    for (const name of [
      'sdd-init-deep',
      'sdd-spec-cheap',
      'jd-judge-a-deep',
      'jd-judge-b-deep',
      'review-validator',
    ]) {
      for (const mode of MODES) {
        expect(isReservedV3(name, mode), `${name}@${mode}`).toBe(true);
      }
    }
  });

  it('RESERVED_EXACT names stay reserved at EVERY mode', () => {
    for (const name of ['general', 'explore', 'gentle-orchestrator']) {
      for (const mode of MODES) {
        expect(isReservedV3(name, mode), `${name}@${mode}`).toBe(true);
      }
    }
  });

  it('the sdd- prefix stays reserved at EVERY mode — exact-roster, NO prefix relaxation', () => {
    for (const name of ['sdd-mine', 'sdd-anything-else', 'sdd-onboard']) {
      for (const mode of MODES) {
        expect(isReservedV3(name, mode), `${name}@${mode}`).toBe(true);
      }
    }
    // Bare/prefix-adjacent names stay user-owned exactly as the legacy
    // case-sensitivity pin defines ('sdd'/'sddx' never matched 'sdd-').
    for (const name of ['sdd', 'sddx']) {
      for (const mode of MODES) {
        expect(isReservedV3(name, mode), `${name}@${mode}`).toBe(false);
      }
    }
  });

  it('non-roster user names keep their legacy ownership at every mode', () => {
    for (const name of ['my-helper', 'Explore', 'mypl']) {
      for (const mode of MODES) {
        expect(isReservedV3(name, mode), `${name}@${mode}`).toBe(false);
        expect(isUserOwnedV3(name, mode), `${name}@${mode}`).toBe(true);
      }
    }
  });

  it('isRosterProtected is exact-set membership over the 13 names', () => {
    for (const name of PHASE_AGENT_ROSTER_NAMES) {
      expect(isRosterProtected(name), name).toBe(true);
    }
    for (const name of [
      'sdd-onboard',
      'sdd-init-deep',
      'sdd-mine',
      'general',
    ]) {
      expect(isRosterProtected(name), name).toBe(false);
    }
  });

  it('LEGACY exports are byte-identical in behavior: mode-blind, roster-blind', () => {
    // The legacy predicate must not have gained any version awareness.
    for (const name of PHASE_AGENT_ROSTER_NAMES) {
      expect(isReserved(name), `legacy ${name}`).toBe(true); // still reserved
      expect(isUserOwned(name), `legacy ${name}`).toBe(false);
    }
    expect(isReserved('my-helper')).toBe(false);
    expect(isUserOwned('my-helper')).toBe(true);
  });
});

describe('ownership — pipeline detection from the definition map (AP-6)', () => {
  const tree = {
    'agent-pipelines': {
      mypl: {
        roles: [
          {
            name: 'mypl-build',
            description: 'd',
            promptSource: 'template',
            prompt: 'p',
          },
          {
            name: 'mypl-review',
            description: 'd',
            promptSource: 'free-text',
            prompt: 'p',
          },
        ],
        orchestrator: { description: 'coordinate' },
        helpers: ['general'],
      },
    },
  } as unknown as ConfigTree;

  it('orchestrator (= pipeline key) and every role are pipeline-owned', () => {
    expect(isPipelineOwned(tree, 'mypl')).toBe(true);
    expect(isPipelineOwned(tree, 'mypl-build')).toBe(true);
    expect(findPipelineOwner(tree, 'mypl-review')).toBe('mypl');
  });

  it('helpers are delegated, NOT owned; unrelated names are user-owned', () => {
    expect(isPipelineOwned(tree, 'general')).toBe(false);
    expect(isPipelineOwned(tree, 'someone-else')).toBe(false);
    expect(isUserOwned('someone-else')).toBe(true); // user-owned ≠ pipeline-free
  });

  it('is malformed-def tolerant: junk entries never claim ownership', () => {
    const junk = {
      'agent-pipelines': {
        broken: 'not-a-record',
        nope: { roles: 'not-an-array', orchestrator: {} },
        empty: {},
      },
    } as unknown as ConfigTree;
    expect(isPipelineOwned(junk, 'broken')).toBe(true); // key itself = orchestrator name
    expect(isPipelineOwned(junk, 'anything')).toBe(false);
    expect(findPipelineOwner(junk, 'anything')).toBeUndefined();
  });
});
