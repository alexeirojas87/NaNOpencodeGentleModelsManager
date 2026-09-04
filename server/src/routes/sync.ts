// WU9.2 — POST /api/sync (design §API-Surface: `{args?}` allowlisted →
// `{exitCode, stdout, stderr}`; "reload after"). The route composes exactly
// two steps over the sync core: validateSyncArgs (400 before any spawn)
// then runSync. Success semantics:
//   • exit 0  → reload CONFIG (load()) and echo its fresh hash, so the
//     client's next save is based on the post-sync bytes (OA-3 "re-reading
//     CONFIG afterward"; the browser then re-GETs /api/config anyway);
//   • non-zero → the outcome ships as-is (200), with NO reload hash and no
//     success marker — the UI must not render a success state for it.
// Sync itself is the user's CLI writing the user's CONFIG: it is an
// EXTERNAL writer to the dashboard's eyes — SCW-2 staleness on a later user
// save is the normal guard, and gentle-ai owns its own restore path
// (~/.gentle-ai/backups), so this endpoint never touches the save pipeline.
import { Hono } from 'hono';

import type { SyncResponse } from '../../../shared/types';
import { load } from '../config/load';
import { runSync, validateSyncArgs } from '../sync';
import { readJsonBody, respondError } from './http';

export const syncRoute = new Hono();

syncRoute.post('/sync', async (c) => {
  try {
    const body = await readJsonBody(c);
    const args = validateSyncArgs(body['args']);
    const result = await runSync(args);
    if (result.exitCode !== 0) {
      return c.json({ ok: true, ...result } satisfies SyncResponse);
    }
    // Reload CONFIG after a successful sync so this response's hash — and
    // every later read — reflects what sync wrote (ConfigLoadError maps to
    // the usual 404/422/500 envelope if sync left CONFIG unreadable).
    const reloaded = await load();
    return c.json({
      ok: true,
      ...result,
      hash: reloaded.hash,
    } satisfies SyncResponse);
  } catch (err) {
    return respondError(c, err);
  }
});
