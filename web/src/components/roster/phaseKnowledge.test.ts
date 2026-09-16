// WU-1 (RED) — the client-side phase knowledge catalog (spec #548
// "Client-side phase catalog", design D3/D8). The catalog is a CLIENT
// CONSTANT: the pinned GET /api/config key set (routes.test.ts:155) forbids
// new ConfigResponse keys, so phase knowledge ships as a module, never as a
// server surface. Pins:
//   • PHASE_IDS is EXACTLY the 14 probe-validated gentle-ai 2.5.0 slugs
//     (design D5 probe C — the CLI is the phase authority);
//   • every entry carries purpose / cognitive load / needs ⊂
//     {reasoning, tools, big-context};
//   • knowledgeFor() returns the catalog row for known slugs and the
//     GENERIC FALLBACK row for anything else (spec S2 "Unknown phase
//     fallback") — unknown phases render read-only, never assignable.
import { describe, expect, it } from 'vitest';

import {
  FALLBACK_KNOWLEDGE,
  type Load,
  knowledgeFor,
  PHASE_IDS,
  PHASE_KNOWLEDGE,
} from './phaseKnowledge';

/** The 14 slugs the gentle-ai CLI accepts (probe C of design #549, D2). */
const EXPECTED_PHASES = [
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
];

const LOADS: Load[] = ['low', 'medium', 'medium-high', 'high'];
const NEEDS = ['reasoning', 'tools', 'big-context'] as const;

describe('phase knowledge catalog — the 14 validated phases (S1 data)', () => {
  it('PHASE_IDS lists exactly the 14 probe-validated slugs in order', () => {
    expect(PHASE_IDS).toEqual(EXPECTED_PHASES);
    expect(PHASE_IDS).toHaveLength(14);
  });

  it('the catalog covers exactly those 14 slugs — no extras, no gaps', () => {
    expect(Object.keys(PHASE_KNOWLEDGE).sort()).toEqual(
      [...EXPECTED_PHASES].sort(),
    );
  });

  it('every entry carries a purpose, a valid load and a needs subset', () => {
    for (const slug of EXPECTED_PHASES) {
      const entry = knowledgeFor(slug);
      expect(typeof entry.purpose).toBe('string');
      expect(entry.purpose.length).toBeGreaterThan(0);
      expect(LOADS).toContain(entry.load);
      expect(Array.isArray(entry.needs)).toBe(true);
      for (const need of entry.needs) {
        expect(NEEDS).toContain(need);
      }
      // No duplicated needs chips.
      expect(new Set(entry.needs).size).toBe(entry.needs.length);
    }
  });

  it('14/14 slugs resolve to their own catalog row (not the fallback)', () => {
    for (const slug of EXPECTED_PHASES) {
      expect(knowledgeFor(slug)).toBe(PHASE_KNOWLEDGE[slug]);
      expect(knowledgeFor(slug)).not.toBe(FALLBACK_KNOWLEDGE);
    }
  });
});

describe('phase knowledge — pinned data rows (explore §Verified facts)', () => {
  it('sdd-apply is high-load implementation work needing tools', () => {
    expect(knowledgeFor('sdd-apply')).toEqual({
      purpose: 'Implements the assigned tasks as working code',
      load: 'high',
      needs: ['tools'],
    });
  });

  it('sdd-propose pairs reasoning with tools at high load', () => {
    expect(knowledgeFor('sdd-propose')).toEqual({
      purpose: 'Drafts the change proposal: intent, scope, approach',
      load: 'high',
      needs: ['reasoning', 'tools'],
    });
  });

  it('sdd-explore needs tools and a big context window', () => {
    expect(knowledgeFor('sdd-explore').needs).toContain('big-context');
    expect(knowledgeFor('sdd-explore').needs).toContain('tools');
  });

  it('jd judges are blind adversarial reviewers needing reasoning only', () => {
    expect(knowledgeFor('jd-judge-a').load).toBe('high');
    expect(knowledgeFor('jd-judge-a').needs).toEqual(['reasoning']);
    expect(knowledgeFor('jd-judge-b').needs).toEqual(['reasoning']);
  });

  it('sdd-init is low-load mechanical bootstrap work needing tools', () => {
    expect(knowledgeFor('sdd-init').load).toBe('low');
    expect(knowledgeFor('sdd-init').needs).toEqual(['tools']);
  });
});

describe('phase knowledge — unknown-slug fallback (S2)', () => {
  it("knowledgeFor('not-a-phase') returns the generic fallback row", () => {
    expect(knowledgeFor('not-a-phase')).toBe(FALLBACK_KNOWLEDGE);
    expect(knowledgeFor('not-a-phase')).toEqual({
      purpose: 'Uncatalogued phase — no validated knowledge',
      load: 'medium',
      needs: [],
    });
  });

  it('the fallback differs from every catalog row (it is genuinely generic)', () => {
    for (const slug of EXPECTED_PHASES) {
      expect(knowledgeFor(slug)).not.toEqual(FALLBACK_KNOWLEDGE);
    }
  });
});
