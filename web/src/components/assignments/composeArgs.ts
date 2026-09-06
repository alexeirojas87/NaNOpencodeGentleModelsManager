// role-model-assignment WU-2 — the pure assignment arg composer (design
// #549 §Interfaces; spec S5/S6/S8/S9).
//
// BATCH IS THE ONLY PATH (D5 probe verdict, batch_supported=YES): the
// sandbox probe ran `gentle-ai sync --profile-phase … --profile-phase …`
// in ONE invocation → exit 0, both agent rows written, both orchestrator
// prompt-table rows updated. The pre-designed sequential-fallback branch
// is DROPPED by that evidence (spec scenario S9 is resolved-by-evidence —
// there is deliberately no runtime test for a queue that does not exist).
//
// The composer mirrors the server-side SYNC_ARG_ALLOWLIST regexes
// (server/src/sync.ts) CLIENT-SIDE so obviously-broken tokens never even
// reach the wire. The server validator stays authoritative: anything the
// mirror wrongly accepts is still 400 sync_bad_args pre-spawn, and this
// module never relaxes the server shapes. Rejected changes are DROPPED AND
// FLAGGED (never emitted) so the panel can surface what was skipped.
// Output tokens derive ONLY from the given keys/values — no hashes, no
// secret-bearing material can enter the argv.
import {
  FALLBACK_KNOWLEDGE,
  knowledgeFor,
  PHASE_KNOWLEDGE,
} from './phaseKnowledge';

/** The two profiles the dashboard assigns (D3 — the VARIANT_SUFFIXES truth). */
const PROFILES = ['cheap', 'deep'] as const;
type Profile = (typeof PROFILES)[number];

/**
 * Client mirror of the server allowlist value patterns (charset door
 * [\w.:/-] — no shell metacharacter can survive either layer):
 *   --profile        <name:provider/model>
 *   --profile-phase  <name:phase:model[/model]>
 */
const PROFILE_VALUE = /^[\w.-]+:[\w.-]+\/[\w.-]+$/;
const PROFILE_PHASE_VALUE = /^[\w.-]+:[\w.-]+:[\w.-]+(?:\/[\w.-]+)?$/;

/** An installed pair "provider/model" — the only value shape selects emit. */
const PAIR_VALUE = /^[\w.-]+\/[\w.-]+$/;

export interface DroppedChange {
  key: string;
  value: string;
  reason: string;
}

export interface CompositionResult {
  /** The allowlist-valid argv, ready for runSync(args). */
  args: string[];
  /** Changes rejected by the client mirror, with the reason each was dropped. */
  dropped: DroppedChange[];
}

/** Parse "<profile>:<target>" — target "orchestrator" or a catalog phase. */
function parseKey(key: string): { profile: Profile; target: string } | null {
  const colon = key.indexOf(':');
  if (colon === -1) return null;
  const profile = key.slice(0, colon);
  const target = key.slice(colon + 1);
  if (!PROFILES.includes(profile as Profile)) return null;
  if (target !== 'orchestrator' && !(target in PHASE_KNOWLEDGE)) return null;
  return { profile: profile as Profile, target };
}

/**
 * Compose ALL changed pairs into the argv of ONE sync invocation: repeated
 * `--profile-phase` flags first (insertion order), then `--profile` flags
 * for the orchestrator rows (design §Data Flow). Invalid changes are
 * dropped-and-flagged, never emitted.
 */
export function composeAssignmentArgsDetailed(
  changes: Record<string, string>,
): CompositionResult {
  const args: string[] = [];
  const profileArgs: string[] = [];
  const dropped: DroppedChange[] = [];
  for (const [key, value] of Object.entries(changes)) {
    const parsed = parseKey(key);
    if (!parsed) {
      const colon = key.indexOf(':');
      const profile = colon === -1 ? '' : key.slice(0, colon);
      const reason = !PROFILES.includes(profile as Profile)
        ? `unknown profile "${profile}" — must be cheap or deep`
        : `unknown phase — the CLI catalog is the phase authority (${key})`;
      dropped.push({ key, value, reason });
      continue;
    }
    if (!PAIR_VALUE.test(value)) {
      dropped.push({
        key,
        value,
        reason: `value must be a "provider/model" pair (allowlist charset)`,
      });
      continue;
    }
    if (parsed.target === 'orchestrator') {
      const token = `${parsed.profile}:${value}`;
      if (!PROFILE_VALUE.test(token)) {
        dropped.push({
          key,
          value,
          reason: 'token rejected by allowlist mirror',
        });
        continue;
      }
      profileArgs.push('--profile', token);
      continue;
    }
    if (knowledgeFor(parsed.target) === FALLBACK_KNOWLEDGE) {
      // Unreachable today (parseKey already gates on the catalog) — kept as
      // an explicit guard so a future catalog change cannot emit unknown
      // phases the CLI would reject (probe C).
      dropped.push({
        key,
        value,
        reason: 'phase is not in the validated catalog',
      });
      continue;
    }
    const token = `${parsed.profile}:${parsed.target}:${value}`;
    if (!PROFILE_PHASE_VALUE.test(token)) {
      dropped.push({
        key,
        value,
        reason: 'token rejected by allowlist mirror',
      });
      continue;
    }
    args.push('--profile-phase', token);
  }
  return { args: [...args, ...profileArgs], dropped };
}

/** Argv-only convenience wrapper (drops are handled by the detailed form). */
export function composeAssignmentArgs(
  changes: Record<string, string>,
): string[] {
  return composeAssignmentArgsDetailed(changes).args;
}
