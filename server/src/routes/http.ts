// WU5.3 — shared HTTP plumbing for the API routes. One error envelope
// ({ok:false, error:{code, message, ...}}) and the exact error-mapping table
// decided with WU4:
//   SaveError 'stale'   → 409 {expected, actual}   (SCW-2 conflict modal)
//   SaveError 'invalid' → 400 {issues[]}           (SCW-3, pre-backup)
//   PatchError off_allowlist|bad_op → 400 {path, opIndex} (SCW-7 / threat #1)
//   ConfigLoadError missing → 404 · parse → 422 · io → 500 — the load failure
//     surface; CONFIG is never created or repaired (PC-1).
// Routes compose load/mask/patch/validate/save (WU2–WU4) and MUST NOT
// hand-roll writes — every mutation goes through save() (SCW-1).
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import type { WriteResponse } from '../../../shared/types';
import { ConfigLoadError, load, type LoadedConfig } from '../config/load';
import { PatchError, type PatchOp } from '../config/patch';
import { SaveError, save, type SaveExpected } from '../config/save';
import { SyncError } from '../sync';

/** A failure that already knows its HTTP status; wrapped by respondError. */
export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Exact mapping of pipeline failures to HTTP (design §API-Surface). */
export function toHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof SaveError) {
    return err.code === 'stale'
      ? new HttpError(409, 'stale', err.message, {
          expected: err.expectedHash,
          actual: err.actualHash,
        })
      : new HttpError(400, 'invalid', err.message, { issues: err.issues });
  }
  if (err instanceof PatchError) {
    // orchestration-v2 D1/AC-1: the set-only create row surfaces 'exists'
    // from patch(); the wire-level code for that rejection is agent_exists.
    return new HttpError(
      400,
      err.code === 'exists' ? 'agent_exists' : err.code,
      err.message,
      {
        path: err.path,
        opIndex: err.opIndex,
      },
    );
  }
  if (err instanceof ConfigLoadError) {
    if (err.code === 'missing')
      return new HttpError(404, 'config_missing', err.message);
    if (err.code === 'parse')
      return new HttpError(422, 'config_unparseable', err.message);
    return new HttpError(500, 'config_io', err.message);
  }
  if (err instanceof SyncError) {
    const extra: Record<string, unknown> = {};
    if (err.argIndex !== undefined) extra.argIndex = err.argIndex;
    if (err.arg !== undefined) extra.arg = err.arg;
    if (err.code === 'sync_bad_args')
      return new HttpError(400, err.code, err.message, extra);
    // sync_timeout (504) / sync_output_limit + spawn failures (500): the
    // request itself failed — the sync OUTCOME path is the 200 SyncResponse.
    if (err.code === 'sync_timeout')
      return new HttpError(504, err.code, err.message, extra);
    return new HttpError(500, err.code, err.message, extra);
  }
  return new HttpError(
    500,
    'internal_error',
    err instanceof Error ? err.message : String(err),
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Own-key lookup — never matches inherited keys like `__proto__`. */
export function hasOwnRecord(container: unknown, key: string): boolean {
  return isRecord(container) && Object.hasOwn(container, key);
}

export function respondError(c: Context, err: unknown): Response {
  const e = toHttpError(err);
  return c.json(
    { ok: false, error: { code: e.code, message: e.message, ...e.extra } },
    e.status,
  );
}

// --- request helpers -------------------------------------------------------

export async function readJsonBody(
  c: Context,
): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    throw new HttpError(400, 'bad_request', 'Request body must be valid JSON.');
  }
  if (!isRecord(parsed)) {
    throw new HttpError(
      400,
      'bad_request',
      'Request body must be a JSON object.',
    );
  }
  return parsed;
}

/** Client-echoed base from the body; `hash` is mandatory on every write. */
export function expectedFrom(body: Record<string, unknown>): SaveExpected {
  const hash = body['hash'];
  if (typeof hash !== 'string' || hash.length === 0) {
    throw new HttpError(
      400,
      'bad_request',
      'Body must carry the load-time "hash" (from GET /api/config) so stale writes can be rejected (SCW-2).',
    );
  }
  const expected: SaveExpected = { hash };
  if (typeof body['mtimeMs'] === 'number') expected.mtimeMs = body['mtimeMs'];
  return expected;
}

/** Optional string field: absent → undefined (no op, PC-3 pass-through). */
export function optionalStringField(
  body: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new HttpError(
      400,
      'bad_request',
      `"${field}" must be a string when provided.`,
    );
  }
  return value;
}

export function nonEmptyStringField(
  body: Record<string, unknown>,
  field: string,
): string {
  const value = body[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new HttpError(
      400,
      'bad_request',
      `"${field}" must be a non-empty string.`,
    );
  }
  return value;
}

export function recordField(
  body: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  const value = body[field];
  if (!isRecord(value)) {
    throw new HttpError(
      400,
      'bad_request',
      `"${field}" must be a JSON object.`,
    );
  }
  return value;
}

// --- existence guards --------------------------------------------------------

/**
 * Provider ids are never created or removed through the API (PC-4):
 * operations on an unknown id are 404 before anything reaches save().
 */
export async function requireProvider(
  id: string,
): Promise<{ loaded: LoadedConfig; entry: Record<string, unknown> }> {
  const loaded = await load();
  if (!hasOwnRecord(loaded.tree.provider, id)) {
    throw new HttpError(
      404,
      'provider_not_found',
      `Provider "${id}" is not present in CONFIG — creating provider ids is out of scope.`,
    );
  }
  const entry = (loaded.tree.provider as Record<string, unknown>)[id];
  return { loaded, entry: isRecord(entry) ? entry : {} };
}

/**
 * Agent gate for OA-2: there is NO allowlist of agent names — any agent
 * present under CONFIG `agent.*` is writable — but the agent must exist
 * (a ghost name is a typo, not something to invent in CONFIG).
 */
export async function requireAgent(name: string): Promise<LoadedConfig> {
  const loaded = await load();
  if (!hasOwnRecord(loaded.tree.agent, name)) {
    throw new HttpError(
      404,
      'agent_not_found',
      `Agent "${name}" is not present in CONFIG (any existing agent is writable — there is no name allowlist).`,
    );
  }
  return loaded;
}

// --- CX-3 restart carrier ------------------------------------------------------

/**
 * Once THIS server process has written CONFIG through the save() pipeline,
 * a running OpenCode needs a restart to pick the change up. GET /api/status
 * reports the flag; the UI renders "Restart OpenCode to apply" (CX-3).
 */
let savePerformed = false;
export function noteConfigSaved(): void {
  savePerformed = true;
}
export function restartRequired(): boolean {
  return savePerformed;
}

/** Run the SCW-1 pipeline for one request and answer with WriteResponse. */
export async function runSave(
  c: Context,
  body: Record<string, unknown>,
  ops: readonly PatchOp[],
): Promise<Response> {
  // save() IS the only write path (SCW-1): stale → patch → validate →
  // backup → atomic rename → reload. The echoed hash is the next valid base.
  const result = await save(ops, expectedFrom(body));
  noteConfigSaved();
  return c.json({ ok: true, hash: result.hash } satisfies WriteResponse);
}
