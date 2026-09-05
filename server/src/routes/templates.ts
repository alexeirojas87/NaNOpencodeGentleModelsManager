// orchestration-v2 WU-A 1.5 — GET /api/templates: the four bundled create
// presets (design D3, AT-1). Static JSON shipped with the server, same
// offline pattern as the nan-snapshot catalog (CX-4): the browser never
// touches fs. Pure read — no CONFIG, no writes, no auth beyond CX-1.
import { Hono } from 'hono';

import type { AgentTemplate, TemplatesResponse } from '../../../shared/types';
import asset from '../templates/agent-templates.json';

export const templatesRoute = new Hono();

templatesRoute.get('/templates', (c) => {
  const body: TemplatesResponse = {
    templates: asset.templates as AgentTemplate[],
  };
  return c.json(body);
});
