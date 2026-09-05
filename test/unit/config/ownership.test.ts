// agent-pipelines WU-1 task 1.1 (RED) — ownership predicate (AP-6, AC-3) and
// the blocklist parity table: the AC-3 surface MUST stay ⊇ the C-G4 reserved
// set at every pin bump (AP-8). 23 base keys enumerated from gentle-ai's
// sdd-overlay-multi.json at research pin d4518aae, re-cited at head
// 9c73c731 (WU-0: blob-identical). isUserOwned = ¬isReserved; pipeline
// detection reads the CONFIG `agent-pipelines` definition map tolerantly.
// Pure unit — no fs, sandbox rule N/A.
import { describe, expect, it } from 'vitest';

import type { ConfigTree } from '../../../server/src/config/load';
import {
  findPipelineOwner,
  isPipelineOwned,
  isReserved,
  isUserOwned,
  MAX_PROMPT_BYTES,
  NAME_RE,
  NAME_UNSAFE,
  REF_RE,
} from '../../../server/src/config/ownership';

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
