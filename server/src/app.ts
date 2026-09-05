// WU5.1 — the Hono application. Split from the serve() entry point (index.ts)
// so integration tests can drive the full route table with app.request()
// without listening on a port (task 5.2). Mounting order matters: the API
// is registered before the static handler, so /api/* can never be shadowed
// by a file in the web bundle.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';

import { agentsRoute } from './routes/agents';
import { catalogRoute } from './routes/catalog';
import { configRoute } from './routes/config';
import { modelsRoute } from './routes/models';
import { providersRoute } from './routes/providers';
import { statusRoute } from './routes/status';
import { syncRoute } from './routes/sync';
import { templatesRoute } from './routes/templates';

export const app = new Hono();

// Health probe kept from the bootstrap stub (deployment/readiness checks).
app.get('/api/health', (c) => c.json({ ok: true }));

app.route('/api', configRoute);
app.route('/api', catalogRoute);
app.route('/api', providersRoute);
app.route('/api', modelsRoute);
app.route('/api', agentsRoute);
// WU-A (orchestration-v2): bundled create presets + POST /api/agents in agents.
app.route('/api', templatesRoute);
app.route('/api', statusRoute);
// WU9: gentle-ai sync pass-through (OA-3) — argv allowlist, execFile, reload.
app.route('/api', syncRoute);

// Production static serving (design §Architecture "Layout"): `pnpm build`
// emits the web bundle to repo-root dist/; when it exists the same server
// serves it alongside the API. In dev, Vite (:5173) proxies /api here instead
// (WU1 scripts), so dist is usually absent and this branch stays dark.
const distDir = fileURLToPath(new URL('../../dist', import.meta.url));
if (existsSync(distDir)) {
  app.get('*', serveStatic({ root: distDir }));
  app.get('*', (c) => {
    if (c.req.path.startsWith('/api/')) {
      return c.json(
        {
          ok: false,
          error: { code: 'not_found', message: 'No such endpoint.' },
        },
        404,
      );
    }
    // SPA fallback: client-side routing owns everything non-API.
    return c.html(readFileSync(join(distDir, 'index.html'), 'utf8'));
  });
}

// Uniform JSON 404 for unmatched API routes (matches the error envelope).
app.notFound((c) =>
  c.json(
    {
      ok: false,
      error: {
        code: 'not_found',
        message: `No route for ${c.req.method} ${c.req.path}`,
      },
    },
    404,
  ),
);
