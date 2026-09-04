// WU5.3 — PUT /api/agents/:name/model (design §API-Surface, OA-1/OA-2).
// Set:   {hash, model: "<provider>/<model-id>"} → value op on the whole key.
// Clear: {hash, model: null}                    → REMOVE op: only the model
//   key disappears; sibling keys (description, prompt, tools, gentle-ai:*
//   markers) keep their bytes (OA-2 scenario, OA-4 via save()).
// There is NO server-side allowlist of agent names: :name addresses any agent
// present under CONFIG `agent.*` (the gate is CONFIG content, not a list);
// an absent agent 404s so a typo never invents one.
import { Hono } from 'hono';

import type { PatchOp } from '../config/patch';
import {
  HttpError,
  readJsonBody,
  requireAgent,
  respondError,
  runSave,
} from './http';

export const agentsRoute = new Hono();

agentsRoute.put('/agents/:name/model', async (c) => {
  try {
    const body = await readJsonBody(c);
    const name = c.req.param('name');
    await requireAgent(name);
    if (!('model' in body)) {
      throw new HttpError(
        400,
        'bad_request',
        'Body must carry "model": a "provider/model" string to set, or null to clear.',
      );
    }
    const modelPath = ['agent', name, 'model'];
    const value = body['model'];
    let op: PatchOp;
    if (value === null) {
      op = { path: modelPath, remove: true }; // clear → runtime default
    } else if (typeof value === 'string' && value.length > 0) {
      op = { path: modelPath, value };
    } else {
      throw new HttpError(
        400,
        'bad_request',
        '"model" must be a non-empty "provider/model" string or null.',
      );
    }
    return await runSave(c, body, [op]);
  } catch (err) {
    return respondError(c, err);
  }
});
