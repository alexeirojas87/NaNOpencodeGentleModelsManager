// WU5.3 — PUT /api/providers/:id (design §API-Surface).
// Body {hash, name?, npm?, baseURL?, apiKey?} → WriteResponse {ok, hash}.
// Omitted fields produce NO op, so their bytes round-trip untouched (PC-3);
// apiKey is an opaque string — provided = replace verbatim, never a masked
// placeholder (the request path never sees maskConfig output). Unknown
// provider ids are 404: provider creation is out of scope (PC-4).
import { Hono } from 'hono';

import type { PatchOp } from '../config/patch';
import {
  optionalStringField,
  readJsonBody,
  requireProvider,
  respondError,
  runSave,
} from './http';

export const providersRoute = new Hono();

providersRoute.put('/providers/:id', async (c) => {
  try {
    const body = await readJsonBody(c);
    const id = c.req.param('id');
    await requireProvider(id);
    // Flat body keys map onto their allowlisted paths (design §API-Surface).
    const fields: [field: string, path: string[]][] = [
      ['name', ['provider', id, 'name']],
      ['npm', ['provider', id, 'npm']],
      ['baseURL', ['provider', id, 'options', 'baseURL']],
      ['apiKey', ['provider', id, 'options', 'apiKey']],
    ];
    const ops: PatchOp[] = [];
    for (const [field, path] of fields) {
      const value = optionalStringField(body, field);
      if (value !== undefined) ops.push({ path, value });
    }
    return await runSave(c, body, ops);
  } catch (err) {
    return respondError(c, err);
  }
});
