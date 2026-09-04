// WU5.3 — GET /api/status (design §API-Surface). Minimal honest fields:
// current CONFIG identity (path/hash/mtime) for staleness display, the
// dashboard-owned backup inventory newest-first (restore points, SCW-4),
// and the process-local restart flag (CX-3 carrier). Since WU7 the drift[]
// and snapshotAsOf report REAL cells: declared-vs-snapshot contextWindow
// comparisons from the bundled catalog — advisory only, never blocking
// (MC-5: the save pipeline never consults this endpoint).
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { Hono } from 'hono';

import type { StatusResponse } from '../../../shared/types';
import { computeDrift, nanSnapshot } from '../catalog';
import { load } from '../config/load';
import { defaultBackupDir } from '../config/backup';
import { respondError, restartRequired } from './http';

export const statusRoute = new Hono();

// Same name contract as backup.ts (its own copy is module-private; pruning
// there guarantees only these names exist in the dir).
const BACKUP_FILE = /^opencode-.*\.json$/;

statusRoute.get('/status', async (c) => {
  try {
    const loaded = await load();
    const dir = defaultBackupDir(loaded.path);
    let backups: string[] = [];
    try {
      backups = (await readdir(dir))
        .filter((name) => BACKUP_FILE.test(name))
        .sort()
        .reverse() // ISO names sort chronologically → newest first
        .map((name) => join(dir, name));
    } catch {
      // no backup dir yet — this CONFIG has never been saved by the dashboard
    }
    const body: StatusResponse = {
      path: loaded.path,
      hash: loaded.hash,
      mtime: loaded.mtimeMs,
      // Advisory cells only (MC-5) — providers that do not match the
      // snapshot's npm+name metadata contribute nothing (generic 0..N).
      drift: computeDrift(loaded.tree),
      snapshotAsOf: nanSnapshot.asOf,
      backups,
      restartRequired: restartRequired(),
    };
    return c.json(body);
  } catch (err) {
    return respondError(c, err);
  }
});
