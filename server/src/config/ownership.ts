// agent-pipelines WU-1 task 1.2 — single ownership module (design §Ownership
// predicate, AP-6). NAME_RE/NAME_UNSAFE/RESERVED_* relocate here from
// routes/agents.ts (behavior-neutral move; the route now imports them) so
// patch/validate/routes/materializer share ONE gate authority.
//
// AP-6 (resolves deferred decision #5):
//   user-owned     ⇔ ¬reserved (AC-3 is the whole provenance story — rows
//                    stay plain OpenCode entries, byte-identical under sync,
//                    C-G1/C-G2; gentle-ai treats any key outside its managed
//                    surface as user-owned, `managedProfileAgentName`).
//   pipeline-owned ⇔ name is a pipeline key (orchestrator row) or appears as
//                    a role in some definition's roles[]. Write gating
//                    (SCW-7 c/d) uses user-owned; cascade/lockstep (AP-4/AP-5)
//                    uses pipeline-owned. Helpers are delegated-to, not owned.
import type { ConfigTree } from './load';

/** Name charset gate (AC-2) — project convention; upstream has none [S1–S4]. */
export const NAME_RE = /^[\w.-]+$/;
/** The regex alone permits these — they must never reach the patch layer. */
export const NAME_UNSAFE = new Set([
  '.',
  '..',
  '__proto__',
  'constructor',
  'prototype',
]);
/**
 * gentle-ai sync silently deep-merges these (AC-3, C2.1/C2.4 [S5][S6];
 * re-verified against gentle-ai@main at pre-apply, WU-0 task 0.1). Case
 * sensitive by spec: `Explore` and bare `sdd` are legal user agents. Parity
 * ⊇ the C-G4 23-base-key surface is pinned by the AP-8 table test.
 */
export const RESERVED_PREFIXES = ['sdd-', 'jd-', 'review-'];
export const RESERVED_EXACT = new Set([
  'general',
  'explore',
  'gentle-orchestrator',
]);
/** AC-5/OA-4': `{file:…}` reference form — ANCHORED (whole-string) gate;
 * mid-string `{file:` is inert prompt text (explore Q7, threat XSS). */
export const REF_RE = /^\s*\{file:(.*)\}\s*$/;
/** AC-5 64 KiB cap; AT-3 caps materialized file content at the same size. */
export const MAX_PROMPT_BYTES = 65536;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** AC-3 reserved-name authority — sync-managed names the dashboard never writes. */
export function isReserved(name: string): boolean {
  return (
    RESERVED_EXACT.has(name) ||
    RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/** AP-6: user-owned is exactly ¬reserved (prefixes and naming stay free). */
export function isUserOwned(name: string): boolean {
  return !isReserved(name);
}

/**
 * Owning pipeline key for `name`, reading the definition map TOLERANTLY:
 * malformed entries are skipped, never thrown on (validate() is the shape
 * authority; this is a lookup over possibly-externally-authored CONFIG).
 * A present key always claims its orchestrator row (row name ≡ pipeline
 * name); roles claim their `roles[].name`. Helpers claim nothing.
 */
export function findPipelineOwner(
  tree: ConfigTree,
  name: string,
): string | undefined {
  const defs = tree['agent-pipelines'];
  if (!isRecord(defs)) return undefined;
  if (Object.hasOwn(defs, name)) return name; // orchestrator row ≡ pipeline key
  for (const [key, def] of Object.entries(defs)) {
    if (!isRecord(def)) continue;
    const roles = def['roles'];
    if (!Array.isArray(roles)) continue;
    for (const role of roles) {
      if (isRecord(role) && role['name'] === name) return key;
    }
  }
  return undefined;
}

/** AP-6: appears as orchestrator or role in some `agent-pipelines` entry. */
export function isPipelineOwned(tree: ConfigTree, name: string): boolean {
  return findPipelineOwner(tree, name) !== undefined;
}
