// WU5.3 — PUT /api/agents/:name/model (design §API-Surface, OA-1/OA-2).
// Set:   {hash, model: "<provider>/<model-id>"} → value op on the whole key.
// Clear: {hash, model: null}                    → REMOVE op: only the model
//   key disappears; sibling keys (description, prompt, tools, gentle-ai:*
//   markers) keep their bytes (OA-2 scenario, OA-4 via save()).
// There is NO server-side allowlist of agent names: :name addresses any agent
// present under CONFIG `agent.*` (the gate is CONFIG content, not a list);
// an absent agent 404s so a typo never invents one.
//
// orchestration-v2 WU-A adds two routes to this file:
//   POST /api/agents                — whole-entry CREATE, set-only (AC-1..AC-7)
//   GET  /api/agents/:name/prompt   — read-only prompt materialization (D4)
import { dirname, resolve, sep } from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';

import { Hono } from 'hono';

import type { AgentPromptResponse } from '../../../shared/types';
import { load } from '../config/load';
import type { PatchOp } from '../config/patch';
import {
  HttpError,
  isRecord,
  readJsonBody,
  recordField,
  requireAgent,
  respondError,
  runSave,
} from './http';

export const agentsRoute = new Hono();

// --- POST /api/agents gate constants (design D2) ----------------------------

/** Name charset gate (AC-2) — project convention; upstream has none [S1–S4]. */
const NAME_RE = /^[\w.-]+$/;
/** The regex alone permits these — they must never reach the patch layer. */
const NAME_UNSAFE = new Set([
  '.',
  '..',
  '__proto__',
  'constructor',
  'prototype',
]);
/**
 * gentle-ai sync silently deep-merges these (AC-3, C2.1/C2.4 [S5][S6];
 * re-verified against gentle-ai@main 71cf25f9 at pre-apply, task 1.0).
 * Case-sensitive by spec: `Explore` and bare `sdd` are legal user agents.
 */
const RESERVED_PREFIXES = ['sdd-', 'jd-', 'review-'];
const RESERVED_EXACT = new Set(['general', 'explore', 'gentle-orchestrator']);
/** AC-4: the ONLY keys a create may carry (first offender is named). */
const ENTRY_FIELDS = new Set(['model', 'description', 'prompt']);
/** AC-5/AT-2: `{file:…}` reference form — never persisted, resolved read-only. */
const REF_RE = /^\s*\{file:(.*)\}\s*$/;
/** AC-5 64 KiB cap; AT-3 caps materialized file content at the same size. */
const MAX_PROMPT_BYTES = 65536;

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

/** Gate 8 (AC-6): is `model` a `<provider>/<model-id>` pair in this CONFIG?
 * Matched against the constructed pair set — the OA-2 installedPairs rule,
 * server-side, so no provider/model id ambiguity from naive splitting. */
async function modelIsInstalled(model: unknown): Promise<boolean> {
  if (typeof model !== 'string') return false;
  const providers = (await load()).tree.provider;
  if (!isRecord(providers)) return false;
  for (const [pid, entry] of Object.entries(providers)) {
    const models =
      isRecord(entry) && isRecord(entry['models']) ? entry['models'] : {};
    for (const mid of Object.keys(models)) {
      if (`${pid}/${mid}` === model) return true;
    }
  }
  return false;
}

/**
 * POST /api/agents — whole-entry CREATE, set-only (SCW-7 row, design D2).
 * The gate order below is PINNED: every 400 is decided before anything
 * enters the save pipeline (pre-mutation, deterministic); the hash chain in
 * save() is the real serializer — stale surfaces there as 409, and the
 * exists-gate rides the insert flag into patch() (400 agent_exists, still
 * pre-write). Success echoes the fresh post-write hash (AC-7).
 */
agentsRoute.post('/agents', async (c) => {
  try {
    // 1. Body must be a JSON object.
    const body = await readJsonBody(c);
    // 2. name — non-empty string.
    const name = body['name'];
    if (typeof name !== 'string' || name.length === 0) {
      throw new HttpError(
        400,
        'name_invalid',
        '"name" must be a non-empty string.',
      );
    }
    // 3. name charset + explicit rejection of segment-hostile names that the
    //    regex permits (`.`, `..`, `__proto__`, …) — threat name-injection #1.
    if (!NAME_RE.test(name) || NAME_UNSAFE.has(name)) {
      throw new HttpError(
        400,
        'name_invalid',
        `"${name}" is not a valid agent name — must match ${NAME_RE} and must not be . / .. / __proto__ / constructor / prototype.`,
      );
    }
    // 4. reserved-name blocklist (case-sensitive, AC-3).
    if (
      RESERVED_EXACT.has(name) ||
      RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix))
    ) {
      throw new HttpError(
        400,
        'reserved_name',
        `Agent name "${name}" is owned by gentle-ai sync (${RESERVED_PREFIXES.join('/')}* prefixes + ${[...RESERVED_EXACT].join(', ')}) — a next sync would silently deep-merge over it.`,
      );
    }
    // 5. agent must be a record.
    const entry = recordField(body, 'agent');
    // 6. entry keys ⊆ {model, description, prompt} — name the first offender.
    for (const key of Object.keys(entry)) {
      if (!ENTRY_FIELDS.has(key)) {
        throw new HttpError(
          400,
          'unknown_field',
          `agent.${key} is not writable at create — only model, description and prompt are accepted.`,
          { field: key },
        );
      }
    }
    // 7. prompt: required → string → not a {file:} ref → ≤ 64 KiB (AC-5).
    const prompt = Object.hasOwn(entry, 'prompt') ? entry['prompt'] : undefined;
    if (prompt === undefined || prompt === '') {
      throw new HttpError(
        400,
        'prompt_required',
        'agent.prompt is required and must be non-empty — prompts are fixed at creation (OA-4).',
      );
    }
    if (typeof prompt !== 'string') {
      throw new HttpError(
        400,
        'prompt_invalid',
        'agent.prompt must be a string.',
      );
    }
    if (REF_RE.test(prompt)) {
      throw new HttpError(
        400,
        'file_ref_rejected',
        'A {file:…} reference prompt is never persisted — inline the text (the clone flow materializes it for you).',
      );
    }
    if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) {
      throw new HttpError(
        400,
        'prompt_too_large',
        `agent.prompt is ${Buffer.byteLength(prompt, 'utf8')} bytes — the cap is 65536 (64 KiB).`,
      );
    }
    // 8. model, when present, must be an installed pair (AC-6, OA-2 rule).
    if (
      Object.hasOwn(entry, 'model') &&
      !(await modelIsInstalled(entry['model']))
    ) {
      throw new HttpError(
        400,
        'model_unknown',
        `model "${String(entry['model'])}" is not a "<provider>/<model-id>" pair installed in CONFIG — omit the field to use the runtime default.`,
      );
    }
    if (
      Object.hasOwn(entry, 'description') &&
      typeof entry['description'] !== 'string'
    ) {
      throw new HttpError(
        400,
        'bad_request',
        'agent.description must be a string when provided.',
      );
    }
    // 9. Build the value from the whitelisted fields ONLY, in canonical order
    //    (threat file-write #2: nothing unmentioned can ride along).
    const value: Record<string, unknown> = {};
    if (typeof entry['model'] === 'string') value['model'] = entry['model'];
    if (typeof entry['description'] === 'string')
      value['description'] = entry['description'];
    value['prompt'] = prompt;
    // 10. SCW pipeline (SCW-7 set-only row): patch insert-flag → validate →
    //     backup → atomic rename → {ok,hash}; stale 409 / exists 400 inside.
    const op: PatchOp = { path: ['agent', name], value, insert: true };
    return await runSave(c, body, [op]);
  } catch (err) {
    return respondError(c, err);
  }
});

// --- GET /api/agents/:name/prompt (D4, AT-2/AT-3) ----------------------------

/** AT-2 fail-closed error: nothing about the ref is revealed or read. */
function promptUnavailable(name: string): HttpError {
  return new HttpError(
    404,
    'prompt_unavailable',
    `Agent "${name}" has no viewable prompt content — missing, unresolvable or outside the config directory.`,
  );
}

/**
 * Shape gate for a `{file:…}` inner path: `./`-relative only, no `..`
 * segments, no absolute paths, no NUL. Violations fail closed BEFORE any
 * filesystem access (path-traversal threat, design D4).
 */
function isSafeRelRef(ref: string): boolean {
  if (!ref.startsWith('./')) return false;
  const rel = ref.slice(2);
  if (rel.length === 0 || rel.startsWith('/') || rel.includes('\0'))
    return false;
  return !rel.split('/').some((segment) => segment === '..' || segment === '');
}

/**
 * Read-only prompt materialization: inline prompts pass through verbatim;
 * `{file:…}` refs resolve against dirname(CONFIG) with realpath containment
 * and the 64 KiB cap. This is what the clone flow reads — the POST body then
 * carries only materialized literal text (AT-2).
 */
agentsRoute.get('/agents/:name/prompt', async (c) => {
  try {
    const name = c.req.param('name');
    // requireAgent: own-key lookup — `__proto__` never resolves (404).
    const loaded = await requireAgent(name);
    const entry = (loaded.tree.agent as Record<string, unknown>)[name];
    const prompt = isRecord(entry) ? entry['prompt'] : undefined;
    if (typeof prompt !== 'string' || prompt.length === 0) {
      throw promptUnavailable(name);
    }
    const refMatch = REF_RE.exec(prompt);
    if (!refMatch) {
      const body: AgentPromptResponse = { name, source: 'inline', prompt };
      return c.json(body);
    }
    const ref = (refMatch[1] as string).trim();
    if (!isSafeRelRef(ref)) throw promptUnavailable(name);
    const configDir = dirname(loaded.path);
    // realpath both sides BEFORE reading: a symlink inside the config dir
    // still fails containment if its target escaped the directory.
    let realDir: string;
    let realTarget: string;
    try {
      [realDir, realTarget] = await Promise.all([
        realpath(configDir),
        realpath(resolve(configDir, ref)),
      ]);
    } catch {
      throw promptUnavailable(name); // missing file, dangling link, unreadable dir
    }
    if (realTarget !== realDir && !realTarget.startsWith(realDir + sep)) {
      throw promptUnavailable(name);
    }
    const info = await stat(realTarget).catch(() => null);
    if (!info || !info.isFile()) throw promptUnavailable(name);
    if (info.size > MAX_PROMPT_BYTES) {
      throw new HttpError(
        400,
        'prompt_too_large',
        `Referenced prompt is ${info.size} bytes — the cap is 65536 (64 KiB); clone it by hand.`,
      );
    }
    const text = await readFile(realTarget, 'utf8').catch(() => null);
    if (text === null || Buffer.byteLength(text, 'utf8') > MAX_PROMPT_BYTES) {
      if (text !== null)
        throw new HttpError(
          400,
          'prompt_too_large',
          'Referenced prompt exceeds the 64 KiB cap.',
        );
      throw promptUnavailable(name);
    }
    const body: AgentPromptResponse = {
      name,
      source: 'file',
      ref,
      prompt: text,
    };
    return c.json(body);
  } catch (err) {
    return respondError(c, err);
  }
});
