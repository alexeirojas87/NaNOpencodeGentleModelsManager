// WU7 — GET /api/catalog: the bundled offline NaN snapshot (design §UI
// "add from NaN catalog", MC-3 pre-fill source). This is the ONLY way the
// web layer obtains catalog metadata — the browser never reads the
// filesystem (all data via /api/*), and the bundle ships with the app so
// this is offline by construction (CX-4). Pure read: no CONFIG, no writes.
import { Hono } from 'hono';

import type { CatalogResponse } from '../../../shared/types';
import { nanSnapshot } from '../catalog';

export const catalogRoute = new Hono();

catalogRoute.get('/catalog', (c) => {
  const body: CatalogResponse = nanSnapshot;
  return c.json(body);
});
