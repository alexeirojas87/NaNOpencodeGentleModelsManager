// Bootstrap placeholder so `pnpm dev` and the server project have an entry
// point. Replaced by the full Hono app (routes, localhost-only binding
// formalized, prod static serving) in WU5 — see sdd/model-dashboard/tasks 5.1.
import { serve } from '@hono/node-server';
import { Hono } from 'hono';

const app = new Hono();

app.get('/api/health', (c) => c.json({ ok: true }));

serve({ fetch: app.fetch, port: 8787, hostname: '127.0.0.1' });
