// WU5.3 — GET /api/config (design §API-Surface). The masked read surface:
// load() (WU2) + maskConfig() (WU2) compose the ConfigResponse. apiKey values
// never leave the server (CX-2); agents are projected generically from ALL
// `agent.*` entries (OA-1 — 0..N, no hardcoded subset); auth.json is a
// top-level-keys existence reference only (out-of-scope: values). Since WU7
// snapshotAsOf reports the real bundled snapshot (offline bundle, CX-4).
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
import { nanSnapshot } from '../catalog';
import { load } from '../config/load';
import { maskConfig } from '../config/mask';
import type { PatchOp } from '../config/patch';
import {
  hasOwnRecord,
  HttpError,
  isRecord,
  readJsonBody,
  respondError,
  runSave,
} from './http';

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
      // The real bundled value — the snapshot ships offline with the app (CX-4).
      snapshotAsOf: nanSnapshot.asOf,
    };
    return c.json(body);
  } catch (err) {
    return respondError(c, err);
  }
});

// --- AP-7: PUT /api/config/default-agent (picker gate, C-R1d mirror) --------

/**
 * Selection writes are gated to EXISTING, VISIBLE, NON-SUBAGENT primaries —
 * the dashboard is the safety net because the OpenCode loader THROWS at
 * startup for an invalid default_agent (not found / is a subagent / is
 * hidden — the exact defaultInfo throw set; an absent mode is the loader
 * default "all", a hidden flag is mode-independent). Invalid target → 400
 * zero-mutation. `agent: null` CLEARS the key: the unset state is the build
 * fallback, always valid (C-R1d inverse) — removing a key can never produce
 * an invalid value, so clearing must never be gated.
 */
configRoute.put('/config/default-agent', async (c) => {
  try {
    const body = await readJsonBody(c);
    if (!Object.hasOwn(body, 'agent')) {
      throw new HttpError(
        400,
        'bad_request',
        'Body must carry "agent": a visible primary name, or null to clear.',
      );
    }
    const agent = body['agent'];
    if (agent === null) {
      const op: PatchOp = { path: ['default_agent'], remove: true };
      return await runSave(c, body, [op]);
    }
    if (typeof agent !== 'string' || agent.length === 0) {
      throw new HttpError(
        400,
        'bad_request',
        '"agent" must be a non-empty string or null.',
      );
    }
    const loaded = await load();
    const entry = hasOwnRecord(loaded.tree.agent, agent)
      ? (loaded.tree.agent as Record<string, unknown>)[agent]
      : undefined;
    const invalid = (why: string): HttpError =>
      new HttpError(
        400,
        'default_agent_invalid',
        `default_agent "${agent}" rejected: ${why} OpenCode would refuse to start with this selection.`,
      );
    if (!isRecord(entry)) {
      throw invalid(`agent "${agent}" not found in CONFIG.`);
    }
    if (entry['mode'] === 'subagent') {
      throw invalid(`agent "${agent}" is a subagent.`);
    }
    if (entry['hidden'] === true) {
      throw invalid(`agent "${agent}" is hidden.`);
    }
    return await runSave(c, body, [{ path: ['default_agent'], value: agent }]);
  } catch (err) {
    return respondError(c, err);
  }
});
