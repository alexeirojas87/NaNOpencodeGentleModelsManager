// WU5.1 — server entry point. CX-1: the socket binds 127.0.0.1 ONLY
// (0.0.0.0 would leak the apiKey-bearing surface onto the LAN; the app has
// no auth by design — single user, localhost). The app itself lives in
// ./app so tests can call app.request() without opening a port.
// Post-archive single-command UX: `pnpm start` builds and serves here.
// PORT (default 8787, spec D2) moves the production server when the box
// already owns 8787 — safe because the served UI and API are same-origin
// (only the `pnpm dev` Vite proxy hardwires 8787). The hostname stays
// 127.0.0.1 whatever the port, so CX-1 is unaffected.
import { serve } from '@hono/node-server';

import { app } from './app';

const port = Number(process.env.PORT) || 8787;

const server = serve(
  { fetch: app.fetch, hostname: '127.0.0.1', port },
  (info) => {
    console.log(
      `model-dashboard serving on http://127.0.0.1:${info.port} (localhost-only, CX-1)`,
    );
  },
);

// A collision must read as one actionable line, not a stack trace.
server.on('error', (err) => {
  console.error(
    `model-dashboard could not listen on 127.0.0.1:${port} — ${(err as Error).message}. Free the port, or choose another: PORT=<n> pnpm start`,
  );
  process.exit(1);
});
