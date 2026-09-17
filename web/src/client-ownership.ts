// agent-pipelines WU-4 — the CLIENT-SIDE ownership predicate (AP-6/AC-3).
// The SERVER authority is server/src/config/ownership.ts; that module stays
// server-side (its import graph belongs to the config layer). This file is a
// deliberate, minimal copy for render-time gating only: it decides which rows
// get the danger/edit affordances. Every WRITE is still gated server-side —
// drift here could never authorize a mutation, only mirror the badge. The
// parity test in OrchestrationView.test.tsx pins both surfaces element-wise
// against the server module, so the copy cannot silently diverge.
import { PHASE_AGENT_ROSTER_NAMES } from '../../shared/roster';

/** AC-3 reserved prefixes — sync silently deep-merges these (C-G4 parity). */
export const RESERVED_PREFIXES = ['sdd-', 'jd-', 'review-'] as const;
/** AC-3 reserved exact names. */
export const RESERVED_EXACT = new Set([
  'general',
  'explore',
  'gentle-orchestrator',
]);

/** AC-3: sync-managed name — never user-owned, never deletable/editable here. */
export function isReserved(name: string): boolean {
  return (
    RESERVED_EXACT.has(name) ||
    RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/** AP-6: user-owned ⇔ ¬reserved (pipeline membership is a second axis). */
export function isUserOwned(name: string): boolean {
  return !isReserved(name);
}

// --- phase-agents-v3 (design Decision 5): version-gated ownership mirror -----
// Identical logic to the server's isReservedV3/isUserOwnedV3/isRosterProtected
// over the SAME shared roster set (shared/roster.ts — the single creation
// authority, value-imported by the web build exactly like shared/types). At
// 3.x the 13 exact roster names are carved out of the reserved set; at 2.x
// and unknown the predicate IS the legacy one. The only relaxation is the
// exact-roster membership — no prefix relaxation, no provenance markers.

/** Ownership semantics marker — mirrors StatusResponse.gentleAi.mode. */
export type OwnershipMode = '3.x' | '2.x' | 'unknown';

/**
 * Version-gated reserved predicate (server mirror). `mode !== '3.x'` is
 * exactly the legacy answer; at 3.x the ONLY relaxation is the exact-roster
 * membership. Element-wise parity with the server is pinned by the parity
 * describe in OrchestrationView.test.tsx over roster names × modes.
 */
export function isReservedV3(name: string, mode: OwnershipMode): boolean {
  if (mode !== '3.x') return isReserved(name);
  return isReserved(name) && !PHASE_AGENT_ROSTER_NAMES.has(name);
}

/** V3 user-owned: exact inverse of isReservedV3 (AP-6 shape, version-aware). */
export function isUserOwnedV3(name: string, mode: OwnershipMode): boolean {
  return !isReservedV3(name, mode);
}

/**
 * Roster policy membership: the 13 exact phase-agent names, independent of
 * the version — callers version-gate it themselves (the server route hook
 * checks `mode === '3.x'` around this lookup).
 */
export function isRosterProtected(name: string): boolean {
  return PHASE_AGENT_ROSTER_NAMES.has(name);
}
