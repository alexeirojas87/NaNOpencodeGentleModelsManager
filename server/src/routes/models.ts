// WU5.3 — model-entry CRUD under /api/providers/:id/models (design
// §API-Surface). Model entries are written WHOLE only — the allowlist stops
// at provider.<id>.models.<mid> (patch.ts), so per-field PATCH attempts would
// be 400 off_allowlist. What this route composes instead:
//   POST  {hash, modelId, model}        add a whole entry (MC-3 server side;
//                                       sparse stays sparse — MC-1)
//   PUT   {hash, model}  (:modelId)     additive merge into the existing
//                                       entry (MC-4 "edit any field");
//                                       unmentioned fields survive verbatim
//   DELETE {hash}          (:modelId)   confirmed removal (MC-4 — the confirm
//                                       step is client-side; the server just
//                                       applies the op). A missing id is a
//                                       clean 404 BEFORE save(): no write, no
//                                       pointless backup (§API-Surface keeps
//                                       removal idempotent-safe by rejecting
//                                       up front instead of no-op saving).
import { Hono } from 'hono';

import type { PatchOp } from '../config/patch';
import {
  HttpError,
  hasOwnRecord,
  isRecord,
  nonEmptyStringField,
  readJsonBody,
  recordField,
  requireProvider,
  respondError,
  runSave,
} from './http';

export const modelsRoute = new Hono();

function modelsOf(entry: Record<string, unknown>): Record<string, unknown> {
  return isRecord(entry['models']) ? entry['models'] : {};
}

function modelNotFound(id: string, modelId: string): HttpError {
  return new HttpError(
    404,
    'model_not_found',
    `Model "${modelId}" is not present under provider "${id}".`,
  );
}

modelsRoute.post('/providers/:id/models', async (c) => {
  try {
    const body = await readJsonBody(c);
    const id = c.req.param('id');
    // Provider existence gate (PC-4) — save() reloads through the pipeline.
    await requireProvider(id);
    const modelId = nonEmptyStringField(body, 'modelId');
    const model = recordField(body, 'model');
    // The provided object is inserted verbatim (structuredClone in patch()):
    // absent optional fields are never invented (MC-1).
    const op: PatchOp = {
      path: ['provider', id, 'models', modelId],
      value: model,
    };
    return await runSave(c, body, [op]);
  } catch (err) {
    return respondError(c, err);
  }
});

modelsRoute.put('/providers/:id/models/:modelId', async (c) => {
  try {
    const body = await readJsonBody(c);
    const id = c.req.param('id');
    const modelId = c.req.param('modelId');
    const { entry } = await requireProvider(id);
    const models = modelsOf(entry);
    if (!hasOwnRecord(models, modelId)) throw modelNotFound(id, modelId);
    const current = models[modelId];
    if (!isRecord(current)) {
      throw new HttpError(
        400,
        'bad_request',
        `Existing entry "${modelId}" is not a JSON object — refusing to merge.`,
      );
    }
    // Additive merge: existing fields first, provided fields overwrite.
    const merged = { ...current, ...recordField(body, 'model') };
    const op: PatchOp = {
      path: ['provider', id, 'models', modelId],
      value: merged,
    };
    return await runSave(c, body, [op]);
  } catch (err) {
    return respondError(c, err);
  }
});

modelsRoute.delete('/providers/:id/models/:modelId', async (c) => {
  try {
    const body = await readJsonBody(c);
    const id = c.req.param('id');
    const modelId = c.req.param('modelId');
    const { entry } = await requireProvider(id);
    const models = modelsOf(entry);
    if (!hasOwnRecord(models, modelId)) throw modelNotFound(id, modelId);
    const op: PatchOp = {
      path: ['provider', id, 'models', modelId],
      remove: true,
    };
    return await runSave(c, body, [op]);
  } catch (err) {
    return respondError(c, err);
  }
});
