// phase-agents-v3 — the 13-agent 3.0 phase roster (spec area roster-creation,
// design Decision 6). SINGLE shared creation authority consumed by BOTH the
// server ownership predicate (server/src/config/ownership.ts) and the client
// install UI (web/src/components/roster/): exactly 13 agents in FIXED order —
// ten skill-binding sdd-* agents (SDD phase lifecycle) plus three jd-*
// dual-review agents (two blind read-only judges, one bounded fix actor).
//
// sdd-onboard is deliberately EXCLUDED: it is an onboarding walk-through, not
// an apply-phase worker (design Decision 6); its catalog metadata may still
// exist client-side but the roster module is the creation authority.
//
// Prompt discipline (AC-5-compatible): every prompt is INLINE English text,
// ≤ 64 KiB, with ZERO {file:} references — a created roster entry can never
// drift against sync-managed files. Target and skill paths are injected at
// launch; the static prompt fixes only the ROLE CONTRACT (binding instruction
// or judge/fix-actor behavior), never a filesystem location.

/** Roster entry class: what kind of sub-agent contract this prompt carries. */
export type RosterKind = 'skill-binding' | 'judge-a' | 'judge-b' | 'fix-actor';

/** One roster entry as it is POSTed to /api/agents during install. */
export interface PhaseAgentEntry {
  /** Exact OpenCode agent name (also the CONFIG `agent.*` key). */
  name: string;
  kind: RosterKind;
  /** All phase agents are subagents (install payloads send mode:'subagent'). */
  mode: 'subagent';
  /** Inline English role contract, ≤ 64 KiB, zero {file:} references. */
  prompt: string;
  description: string;
}

/** The inline skill-binding prompt — fixed shape, only the phase is substituted. */
const bindingPrompt = (phase: string): string =>
  `Load the ${phase} skill via skill() and execute it as the dedicated sub-agent. Do not delegate further.`;

const JUDGE_A_PROMPT =
  'You are judge A of a blind dual review. You receive two candidate outputs and the review focus; you are blind to their authorship and to judge B\u2019s verdict. Read both candidates in full, evaluate them independently against the given criteria, and return your own verdict with a confidence score and your reasoning. You are read-only: never edit files, never run mutating commands, never contact judge B. Do not delegate further.';

const JUDGE_B_PROMPT =
  'You are judge B of a blind dual review. You receive two candidate outputs and the review focus; you are blind to their authorship and to judge A\u2019s verdict. Read both candidates in full, evaluate them independently against the given criteria, and return your own verdict with a confidence score and your reasoning. You are read-only: never edit files, never run mutating commands, never contact judge A. Do not delegate further.';

const FIX_AGENT_PROMPT =
  'You are the bounded fix actor of a dual-review cycle. You receive an accepted verdict with a bounded list of corrections. Apply exactly those corrections \u2014 no scope expansion, no refactors, no drive-by improvements. Verify each applied correction against the verdict\u2019s acceptance criteria, report what changed, then stop. Do not delegate further.';

/** The SDD phase agents in lifecycle order — each binds its sdd-<phase> skill. */
const SDD_PHASES = [
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
] as const;

const SDD_DESCRIPTIONS: Readonly<Record<(typeof SDD_PHASES)[number], string>> =
  {
    'sdd-init': 'Initialize SDD context, testing capabilities, and registry.',
    'sdd-explore': 'Explore SDD ideas before committing to a change.',
    'sdd-research': 'Investigate optional questions using authorized sources.',
    'sdd-propose': 'Create an SDD change proposal with intent and scope.',
    'sdd-spec': 'Write SDD delta specs with requirements and scenarios.',
    'sdd-design': 'Create the SDD technical design and architecture approach.',
    'sdd-tasks': 'Break an SDD change into implementation tasks.',
    'sdd-apply': 'Implement SDD tasks from specs and design.',
    'sdd-verify': 'Run optional practical diagnostics against implementation.',
    'sdd-archive': 'Archive an SDD change by syncing delta specs.',
  };

const skillBindingEntries = (): PhaseAgentEntry[] =>
  SDD_PHASES.map((phase) => ({
    name: phase,
    kind: 'skill-binding' as const,
    mode: 'subagent' as const,
    prompt: bindingPrompt(phase),
    description: SDD_DESCRIPTIONS[phase],
  }));

/**
 * The 3.0 phase-agent roster — exactly 13 entries, FIXED order (install
 * issues its sequential creates in this order; the parity pin and the
 * ownership truth table iterate the same sequence).
 */
export const PHASE_AGENT_ROSTER: readonly PhaseAgentEntry[] = [
  ...skillBindingEntries(),
  {
    name: 'jd-judge-a',
    kind: 'judge-a',
    mode: 'subagent',
    prompt: JUDGE_A_PROMPT,
    description: 'Blind read-only judge A of the dual-review verdict pair.',
  },
  {
    name: 'jd-judge-b',
    kind: 'judge-b',
    mode: 'subagent',
    prompt: JUDGE_B_PROMPT,
    description: 'Blind read-only judge B of the dual-review verdict pair.',
  },
  {
    name: 'jd-fix-agent',
    kind: 'fix-actor',
    mode: 'subagent',
    prompt: FIX_AGENT_PROMPT,
    description: 'Bounded fix actor applying accepted verdict corrections.',
  },
];

/** Fast membership: the exact 13 roster names, same fixed order. */
export const PHASE_AGENT_ROSTER_NAMES: ReadonlySet<string> = new Set(
  PHASE_AGENT_ROSTER.map((entry) => entry.name),
);
