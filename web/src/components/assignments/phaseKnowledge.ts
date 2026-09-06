// role-model-assignment WU-1 — the client-side phase knowledge catalog
// (spec "Client-side phase catalog"; design D3/D8). This module is a CLIENT
// CONSTANT on purpose: the GET /api/config key set is pinned
// (test/integration/routes.test.ts:155), so phase knowledge can never ride
// the config response — it ships in the bundle instead. The 14 slugs are the
// probe-validated gentle-ai 2.5.0 phase list (design #549 D5 probe C: the
// CLI is the phase authority — it rejects unknown phases with a listing of
// exactly these), and the knowledge rows condense the installed prompt
// survey from the exploration (sdd/role-model-assignment/explore §Verified
// facts). knowledgeFor() NEVER throws: a slug missing from the catalog gets
// the generic fallback row, which the assignments panel renders read-only
// (unknown phases are never assignable — D3).

/** Cognitive load of a phase, as surfaced in the assignments grid. */
export type Load = 'low' | 'medium' | 'medium-high' | 'high';

/** What a phase requires from its assigned model (advisory chips only). */
export type PhaseNeed = 'reasoning' | 'tools' | 'big-context';

export interface PhaseKnowledge {
  /** What the phase does — one line, rendered in the knowledge column. */
  purpose: string;
  /** Cognitive load — rendered as a badge in the knowledge column. */
  load: Load;
  /** Model capabilities the phase leans on (advisory, never blocking). */
  needs: PhaseNeed[];
}

/**
 * The fixed 14-phase catalog (D2/D3). Keyed by the exact slug the gentle-ai
 * CLI accepts in --profile-phase values. jd-* phases have no sdd-* config
 * keys — they are still first-class catalog rows and assignable.
 */
export const PHASE_KNOWLEDGE: Record<string, PhaseKnowledge> = {
  'sdd-init': {
    purpose: 'Bootstraps the SDD workspace and change scaffolding',
    load: 'low',
    needs: ['tools'],
  },
  'sdd-explore': {
    purpose: 'Investigates the codebase before a change is committed to',
    load: 'medium',
    needs: ['tools', 'big-context'],
  },
  'sdd-research': {
    purpose: 'Produces auditable, source-backed evidence',
    load: 'medium',
    needs: ['tools'],
  },
  'sdd-propose': {
    purpose: 'Drafts the change proposal: intent, scope, approach',
    load: 'high',
    needs: ['reasoning', 'tools'],
  },
  'sdd-spec': {
    purpose: 'Writes strict-format delta specs with scenarios',
    load: 'high',
    needs: ['reasoning', 'tools'],
  },
  'sdd-design': {
    purpose: 'Crafts the technical design and threat matrix',
    load: 'high',
    needs: ['reasoning', 'tools'],
  },
  'sdd-tasks': {
    purpose: 'Breaks the design into ordered tasks with line forecasts',
    load: 'medium-high',
    needs: ['tools'],
  },
  'sdd-apply': {
    purpose: 'Implements the assigned tasks as working code',
    load: 'high',
    needs: ['tools'],
  },
  'sdd-verify': {
    purpose: 'Runs the gates and proves the code matches the spec',
    load: 'high',
    needs: ['tools'],
  },
  'sdd-archive': {
    purpose: 'Closes the change and syncs delta specs',
    load: 'low',
    needs: ['tools'],
  },
  'sdd-onboard': {
    purpose: 'Walks users through the workflow on the real codebase',
    load: 'medium',
    needs: ['tools'],
  },
  'jd-judge-a': {
    purpose: 'Blind adversarial reviewer (judge A)',
    load: 'high',
    needs: ['reasoning'],
  },
  'jd-judge-b': {
    purpose: 'Blind adversarial reviewer (judge B)',
    load: 'high',
    needs: ['reasoning'],
  },
  'jd-fix-agent': {
    purpose: 'Applies surgical post-verdict fixes',
    load: 'medium',
    needs: ['tools'],
  },
};

/** The catalog slugs in grid order — the fixed 14-phase list (D3). */
export const PHASE_IDS: string[] = Object.keys(PHASE_KNOWLEDGE);

/**
 * The generic row for slugs outside the catalog (spec S2). Exported so the
 * panel can render unknown-slug rows as read-only fallbacks via identity.
 */
export const FALLBACK_KNOWLEDGE: PhaseKnowledge = {
  purpose: 'Uncatalogued phase — no validated knowledge',
  load: 'medium',
  needs: [],
};

/** Catalog row for a known slug; the generic fallback row otherwise (S2). */
export function knowledgeFor(slug: string): PhaseKnowledge {
  return PHASE_KNOWLEDGE[slug] ?? FALLBACK_KNOWLEDGE;
}
