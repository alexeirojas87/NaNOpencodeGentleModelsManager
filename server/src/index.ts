// WU5.1 — server entry point. CX-1: the socket binds 127.0.0.1 ONLY
// (0.0.0.0 would leak the apiKey-bearing surface onto the LAN; the app has
// no auth by design — single user, localhost). The app itself lives in
// ./app so tests can call app.request() without opening a port.
import { serve } from '@hono/node-server';

import { app } from './app';

serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 8787 }, (info) => {
  console.log(
    `model-dashboard serving on http://127.0.0.1:${info.port} (localhost-only, CX-1)`,
  );
});
