// phase-agents-v3 task 1.6 (RED) — roster composition (map row 8, spec
// scenario "Roster composition", design Decision 6). The shared roster
// module is the CREATION authority: exactly 13 agents in fixed order, ten
// skill-binding sdd-* agents with the inline binding prompt, three jd-*
// role-contract agents, sdd-onboard excluded, zero {file:} references,
// prompts ≤ 64 KiB English. Pure unit — no fs, sandbox rule N/A.
import { describe, expect, it } from 'vitest';

import { MAX_PROMPT_BYTES } from '../../server/src/config/ownership';
import {
  PHASE_AGENT_ROSTER,
  PHASE_AGENT_ROSTER_NAMES,
  type PhaseAgentEntry,
} from '../../shared/roster';

/** The exact fixed order pinned by the spec (design Decision 6). */
const EXPECTED_ORDER = [
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
  'jd-judge-a',
  'jd-judge-b',
  'jd-fix-agent',
];

const BINDING_PROMPT = (phase: string): string =>
  `Load the ${phase} skill via skill() and execute it as the dedicated sub-agent. Do not delegate further.`;

const JUDGE_A_PROMPT =
  'You are judge A of a blind dual review. You receive two candidate outputs and the review focus; you are blind to their authorship and to judge B\u2019s verdict. Read both candidates in full, evaluate them independently against the given criteria, and return your own verdict with a confidence score and your reasoning. You are read-only: never edit files, never run mutating commands, never contact judge B. Do not delegate further.';

const JUDGE_B_PROMPT =
  'You are judge B of a blind dual review. You receive two candidate outputs and the review focus; you are blind to their authorship and to judge A\u2019s verdict. Read both candidates in full, evaluate them independently against the given criteria, and return your own verdict with a confidence score and your reasoning. You are read-only: never edit files, never run mutating commands, never contact judge A. Do not delegate further.';

const FIX_AGENT_PROMPT =
  'You are the bounded fix actor of a dual-review cycle. You receive an accepted verdict with a bounded list of corrections. Apply exactly those corrections \u2014 no scope expansion, no refactors, no drive-by improvements. Verify each applied correction against the verdict\u2019s acceptance criteria, report what changed, then stop. Do not delegate further.';

describe('roster — composition (map row 8, spec "Roster composition")', () => {
  it('yields exactly 13 entries in the fixed spec order', () => {
    expect(PHASE_AGENT_ROSTER.map((e) => e.name)).toEqual(EXPECTED_ORDER);
    expect(PHASE_AGENT_ROSTER).toHaveLength(13);
  });

  it('every entry carries mode subagent and a non-empty description', () => {
    for (const entry of PHASE_AGENT_ROSTER) {
      expect(entry.mode, entry.name).toBe('subagent');
      expect(entry.description.trim().length, entry.name).toBeGreaterThan(0);
    }
  });

  it('the 10 sdd-* entries are skill-binding with the EXACT inline binding prompt', () => {
    const sdd = PHASE_AGENT_ROSTER.filter((e) => e.name.startsWith('sdd-'));
    expect(sdd).toHaveLength(10);
    for (const entry of sdd) {
      expect(entry.kind, entry.name).toBe('skill-binding');
      // Exact-content pin (snapshot-grade): the binding prompt is fixed,
      // only the phase name is substituted.
      expect(entry.prompt, entry.name).toBe(BINDING_PROMPT(entry.name));
    }
  });

  it('jd-judge-a carries the blind read-only judge-A role contract', () => {
    const entry = PHASE_AGENT_ROSTER.find((e) => e.name === 'jd-judge-a');
    expect(entry?.kind).toBe('judge-a');
    expect(entry?.prompt).toBe(JUDGE_A_PROMPT);
  });

  it('jd-judge-b carries the blind read-only judge-B role contract', () => {
    const entry = PHASE_AGENT_ROSTER.find((e) => e.name === 'jd-judge-b');
    expect(entry?.kind).toBe('judge-b');
    expect(entry?.prompt).toBe(JUDGE_B_PROMPT);
  });

  it('jd-fix-agent carries the bounded fix-actor role contract', () => {
    const entry = PHASE_AGENT_ROSTER.find((e) => e.name === 'jd-fix-agent');
    expect(entry?.kind).toBe('fix-actor');
    expect(entry?.prompt).toBe(FIX_AGENT_PROMPT);
  });

  it('sdd-onboard is ABSENT — the roster is the creation authority and excludes it', () => {
    expect(PHASE_AGENT_ROSTER.map((e) => e.name)).not.toContain('sdd-onboard');
    expect(PHASE_AGENT_ROSTER_NAMES.has('sdd-onboard')).toBe(false);
  });

  it('prompts are inline English ≤64KiB with ZERO {file:} references', () => {
    for (const entry of PHASE_AGENT_ROSTER as readonly PhaseAgentEntry[]) {
      expect(entry.prompt.length, entry.name).toBeGreaterThan(0);
      expect(
        Buffer.byteLength(entry.prompt, 'utf8'),
        entry.name,
      ).toBeLessThanOrEqual(MAX_PROMPT_BYTES);
      expect(entry.prompt, entry.name).not.toContain('{file:');
      // English + professional register: printable ASCII only.
      expect(entry.prompt, entry.name).toMatch(/^[\x20-\x7E\u2019\u2014]+$/);
    }
  });

  it('PHASE_AGENT_ROSTER_NAMES is a ReadonlySet of exactly the 13 names', () => {
    expect(PHASE_AGENT_ROSTER_NAMES).toBeInstanceOf(Set);
    expect([...PHASE_AGENT_ROSTER_NAMES]).toEqual(EXPECTED_ORDER);
  });
});
