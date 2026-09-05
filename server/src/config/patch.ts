// WU3.4 — allowlist patch (SCW-7, threat file-write #1, OA-4, PC-4).
// patch(tree, ops) returns a NEW tree carrying the result of every op, or
// throws PatchError BEFORE any mutation when an op is off the allowlist or
// structurally invalid — the whole batch is rejected atomically so routes can
// answer 400 naming the offending path (WU5 maps the code).
//
// Structural sharing (design "untouched subtrees keep same references —
// no rebuild"): the tree is path-copied, not bulk-cloned. Only the chain
// root → leaf of each mutated path is rebuilt; every sibling subtree keeps
// its identity. Inserted VALUES are structuredClone()d so caller-owned
// objects can never alias into the tree.
//
// The Allowlist (spec Definitions / design §Config-Editing-Core) — nothing
// else is writable:
//   provider.<id>.name | provider.<id>.npm
//   provider.<id>.options.baseURL | provider.<id>.options.apiKey
//   provider.<id>.models.<model-id>      (whole entries only)
//   agent.<name>.model | .description | .temperature | .variant
//                        (pipeline-owned names rejected in the loop — AP-4)
//   agent.<name>.prompt  (SCW-7' c — value op, user-owned names only)
//   agent.<name>          (whole entry — SET-ONLY create via insert===true,
//                          and SCW-7' d user-owned DELETE (remove), members
//                          gated against the accumulated definition map)
//   agent-pipelines       (SCW-7' a — whole-value write; per-entry remove)
//   default_agent
import type { ConfigTree } from '../../../shared/types';
import { findPipelineOwner, isReserved } from './ownership';

export interface PatchOp {
  /** Dot path as segments, e.g. ["provider","nan","models","glm5.3-flash"]. */
  path: string[];
  /** New value (deep-cloned on insert). Mutually exclusive with `remove`. */
  value?: unknown;
  /** Delete the key at `path` (missing keys make the op a no-op). */
  remove?: boolean;
  /**
   * Create-only flag (SCW-7 set-only row, design D1): the length-2 path
   * ["agent", name] is allowlisted ONLY as a value op with insert===true,
   * and an already-present entry throws PatchError('exists') — a set-only
   * row can never turn into a silent update or a delete.
   */
  insert?: boolean;
}

export interface PatchOutcome {
  tree: ConfigTree;
  /** Number of ops applied (no-op removals count as applied). */
  applied: number;
}

export type PatchErrorCode =
  | 'off_allowlist'
  | 'bad_op'
  | 'exists'
  /** SCW-7' b/d confinement: pipeline members never answer to generic rows. */
  | 'pipeline_owned';

/** Rejected patch. `path` names the offending dot path for 400 responses. */
export class PatchError extends Error {
  readonly code: PatchErrorCode;
  readonly path: string;
  readonly opIndex: number;

  constructor(
    code: PatchErrorCode,
    path: string,
    opIndex: number,
    message: string,
  ) {
    super(message);
    this.name = 'PatchError';
    this.code = code;
    this.path = path;
    this.opIndex = opIndex;
  }
}

const PROVIDER_FIELDS = new Set(['name', 'npm']);
const PROVIDER_OPTIONS = new Set(['baseURL', 'apiKey']);
const AGENT_FIELDS = new Set([
  'model',
  'description',
  'temperature',
  'variant',
]);
/** Object keys that would enable prototype pollution or path traversal via
 * dynamic access (`.`/`..` pass NAME_RE but are segment-hostile — AC-2 gate
 * backstop, threat name/path-injection). */
const UNSAFE_SEGMENTS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  '.',
  '..',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(segment: string | undefined): segment is string {
  return (
    typeof segment === 'string' &&
    segment.length > 0 &&
    !UNSAFE_SEGMENTS.has(segment)
  );
}

/** Exact Allowlist match for a dot path (SCW-7 / SCW-7' four widenings).
 * Ownership-content gates (pipeline members, reserved prompt names) are
 * decided per-op against the ACCUMULATED TREE in patch() — see below. */
function isAllowlisted(path: readonly string[], op: PatchOp): boolean {
  if (path.length === 1) {
    // The def map is always written WHOLE or per-entry-removed — the map
    // itself is never deletable (AP-5 deletes entry by entry).
    return (
      path[0] === 'default_agent' ||
      (path[0] === 'agent-pipelines' && !op.remove)
    );
  }
  if (!isId(path[0])) return false;

  if (path[0] === 'provider' && isId(path[1])) {
    if (path.length === 3) return PROVIDER_FIELDS.has(path[2]);
    if (path.length === 4 && path[2] === 'options') {
      return PROVIDER_OPTIONS.has(path[3]);
    }
    // Whole-model-entry only: a 5th segment (field inside an entry) is off.
    return path.length === 4 && path[2] === 'models' && isId(path[3]);
  }

  // SCW-7' (a): per-definition REMOVE on the def map. Whole-value SETS ride
  // the length-1 path above; the map itself is never deletable (AP-5 deletes
  // entry by entry) and per-entry def WRITES are off-list — the definition
  // map is always written whole (single-source-of-truth writes).
  if (path[0] === 'agent-pipelines' && path.length === 2 && isId(path[1])) {
    return op.remove === true;
  }

  if (path[0] === 'agent' && isId(path[1]) && path.length === 2) {
    // Whole-entry rows (SCW-7' set-only create + (d) user-owned DELETE):
    // insert with the create flag, or remove (ownership-gated in the loop).
    return op.remove === true || (op.insert === true && !op.remove);
  }
  if (path[0] === 'agent' && isId(path[1]) && path.length === 3) {
    // (c) prompt VALUE op — user-owned gate is ownership-free, reserved-check
    // runs in the loop. Never a remove: prompts are not deletable in place.
    if (path[2] === 'prompt') return !op.remove && op.insert !== true;
    return AGENT_FIELDS.has(path[2]);
  }
  return false;
}

function checkOp(op: PatchOp, index: number): void {
  const dotted = Array.isArray(op.path) ? op.path.join('.') : String(op.path);
  // Structure only — unsafe segments (__proto__…) are allowlist rejections,
  // so offenders get the threat-accurate off_allowlist code.
  if (
    !Array.isArray(op.path) ||
    op.path.length === 0 ||
    op.path.some((s) => typeof s !== 'string' || s.length === 0)
  ) {
    throw new PatchError(
      'bad_op',
      dotted,
      index,
      `Invalid patch operation at index ${index}: path must be a non-empty list of non-empty string segments.`,
    );
  }
  const hasValue = 'value' in op && op.value !== undefined;
  if (hasValue === Boolean(op.remove)) {
    throw new PatchError(
      'bad_op',
      dotted,
      index,
      `Invalid patch operation at index ${index} on "${dotted}": provide exactly one of value or remove.`,
    );
  }
  if (!isAllowlisted(op.path, op)) {
    throw new PatchError(
      'off_allowlist',
      dotted,
      index,
      `Mutation outside the allowlist rejected at "${dotted}" — only allowlisted provider/agent paths and default_agent are writable.`,
    );
  }
}

/** Own-key existence of the leaf a set/insert op would write. */
function leafPresent(root: ConfigTree, path: readonly string[]): boolean {
  let cur: unknown = root;
  for (const segment of path.slice(0, -1)) {
    if (!isRecord(cur) || !(segment in cur)) return false;
    cur = cur[segment];
  }
  return isRecord(cur) && Object.hasOwn(cur, path[path.length - 1]);
}

/** Removal whose chain or leaf does not exist is a no-op (same reference). */
function removable(root: ConfigTree, path: readonly string[]): boolean {
  let cur: unknown = root;
  for (const segment of path) {
    if (!isRecord(cur) || !(segment in cur)) return false;
    cur = cur[segment];
  }
  return true;
}

/** Persistent set: rebuilds only the ancestor chain of `path`. */
function setIn(
  node: Record<string, unknown>,
  path: readonly string[],
  index: number,
  op: PatchOp,
): Record<string, unknown> {
  const clone = { ...node };
  const key = path[index];
  if (index === path.length - 1) {
    if (op.remove) {
      delete clone[key];
    } else {
      clone[key] = structuredClone(op.value);
    }
  } else {
    const child = clone[key];
    clone[key] = setIn(isRecord(child) ? child : {}, path, index + 1, op);
  }
  return clone;
}

/**
 * Apply `ops` to `tree` without touching the input. Throws PatchError on the
 * first invalid op after checking ALL ops, so a rejected batch never mutates
 * anything and a 400 can name the path (threat file-write #1 response).
 *
 * SCW-7' b/c/d confinement runs in the ACCUMULATED-TREE loop: each op is
 * checked against the state earlier ops of THIS batch produced. That is what
 * makes the design's delete ordering (def-map-minus-entry FIRST, then row
 * removes) decisive — a pipeline member answers to row (d) only after its
 * definition stopped claiming it; standalone member removals throw
 * pipeline_owned naming the owner. The builder's row-regeneration pair
 * (remove+insert on the same path, mid lifecycle batch) is not a deletion:
 * a present paired insert admits the remove.
 */
export function patch(tree: ConfigTree, ops: readonly PatchOp[]): PatchOutcome {
  ops.forEach(checkOp);

  const agentName = (path: readonly string[]): string | undefined =>
    path[0] === 'agent' && isId(path[1]) ? path[1] : undefined;
  const inserted = new Set(
    ops
      .filter((op) => op.insert === true && !op.remove)
      .map((op) => op.path.join('.')),
  );

  let current = tree;
  for (const [opIndex, op] of ops.entries()) {
    const dotted = op.path.join('.');
    const name = agentName(op.path);
    if (name !== undefined) {
      const owner = findPipelineOwner(current, name);
      if (op.path.length === 3 && op.path[2] === 'prompt') {
        // (c) user-owned gate (AP-6: user-owned ⇔ ¬reserved).
        if (isReserved(name)) {
          throw new PatchError(
            'off_allowlist',
            dotted,
            opIndex,
            `Mutation rejected at "${dotted}": agent "${name}" is owned by gentle-ai sync — its prompt is never writable through the dashboard (SCW-7 c).`,
          );
        }
      } else if (op.path.length === 2 && op.remove === true) {
        // (d) user-owned standalone gate: reserved names never delete, and
        // pipeline members only answer after their definition stopped
        // claiming them (delete-batch ordering) or via a paired rewrite.
        if (isReserved(name)) {
          throw new PatchError(
            'off_allowlist',
            dotted,
            opIndex,
            `Mutation rejected at "${dotted}": agent "${name}" is owned by gentle-ai sync — never deletable through the dashboard (SCW-7 d).`,
          );
        }
        if (owner !== undefined && !inserted.has(dotted)) {
          // SCW-7a half: definitions cannot bypass delete gates.
          throw new PatchError(
            'pipeline_owned',
            dotted,
            opIndex,
            `Mutation rejected at "${dotted}": agent "${name}" is a member of pipeline "${owner}" — delete the pipeline (which removes its rows atomically) instead of removing the member.`,
          );
        }
      } else if (op.path.length === 3 && owner !== undefined) {
        // AP-4: generic edits on members belong to the pipeline builder.
        throw new PatchError(
          'pipeline_owned',
          dotted,
          opIndex,
          `Mutation rejected at "${dotted}": agent "${name}" is a member of pipeline "${owner}" — generic edits are rejected; edit it through the pipeline builder.`,
        );
      }
    }
    // Set-only create row: an insert over a present leaf is rejected here —
    // still pre-disk, so the caller answers 400 agent_exists (SCW-7/AC-1).
    if (op.insert && !op.remove && leafPresent(current, op.path)) {
      throw new PatchError(
        'exists',
        op.path.join('.'),
        opIndex,
        `Create-only op rejected: "${op.path.join('.')}" already exists — this path is set-only (never update, never delete).`,
      );
    }
    if (op.remove && !removable(current, op.path)) continue;
    current = setIn(current, op.path, 0, op);
  }
  return { tree: current, applied: ops.length };
}
