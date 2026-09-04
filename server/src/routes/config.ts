// WU5.3 — GET /api/config (design §API-Surface). The masked read surface:
// load() (WU2) + maskConfig() (WU2) compose the ConfigResponse. apiKey values
// never leave the server (CX-2); agents are projected generically from ALL
// `agent.*` entries (OA-1 — 0..N, no hardcoded subset); auth.json is a
// top-level-keys existence reference only (out-of-scope: values); snapshotAsOf
// is null until the bundled NaN snapshot ships in WU7.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';

import type {
  AgentConfigEntry,
  ConfigResponse,
  MaskedConfigTree,
  MaskedProvider,
} from '../../../shared/types';
import { load } from '../config/load';
import { maskConfig } from '../config/mask';
import { isRecord, respondError } from './http';

export const configRoute = new Hono();

/**
 * auth.json location — same sandbox convention as CONFIG_PATH: AUTH_PATH
 * overrides for tests; default is OpenCode's data-dir auth store. Only the
 * top-level keys (account/provider names) are ever read into a response.
 */
export function resolveAuthPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const fromEnv = env.AUTH_PATH?.trim();
  if (fromEnv) return fromEnv;
  return join(
    env.HOME || homedir(),
    '.local',
    'share',
    'opencode',
    'auth.json',
  );
}

/** Existence-only reference: names present in auth.json, values never leave it. */
async function authJsonExists(): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(resolveAuthPath(), 'utf8'),
    );
    return isRecord(parsed) ? Object.keys(parsed) : [];
  } catch {
    return []; // missing/unreadable auth.json simply has no references
  }
}

configRoute.get('/config', async (c) => {
  try {
    const loaded = await load(); // ConfigLoadError → 404/422/500 (PC-1)
    const masked = maskConfig(loaded.tree) as MaskedConfigTree;
    const body: ConfigResponse = {
      hash: loaded.hash,
      mtime: loaded.mtimeMs,
      // Generic over 0..N provider ids and agent names (PC-4, OA-1).
      providers: (masked.provider ?? {}) as Record<string, MaskedProvider>,
      agents: (masked.agent ?? {}) as Record<string, AgentConfigEntry>,
      defaultAgent: masked.default_agent,
      authJson: { exists: await authJsonExists() },
      snapshotAsOf: null, // the bundled snapshot ships in WU7
    };
    return c.json(body);
  } catch (err) {
    return respondError(c, err);
  }
});
