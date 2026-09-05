// agent-pipelines WU-4 — the CLIENT-SIDE ownership predicate (AP-6/AC-3).
// The SERVER authority is server/src/config/ownership.ts; that module stays
// server-side (its import graph belongs to the config layer). This file is a
// deliberate, minimal copy for render-time gating only: it decides which rows
// get the danger/edit affordances. Every WRITE is still gated server-side —
// drift here could never authorize a mutation, only mirror the badge. The
// parity test in OrchestrationView.test.tsx pins both surfaces element-wise
// against the server module, so the copy cannot silently diverge.

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
