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
// agent-pipelines WU-1 task 1.2: the AC-2/AC-3/AC-5 gate constants relocated
// to config/ownership.ts (behavior-neutral move — one shared gate authority;
// the checks below keep their exact pinned order and messages).
import {
  findPipelineOwner,
  isReservedV3,
  isRosterProtected,
  MAX_PROMPT_BYTES,
  NAME_RE,
  NAME_UNSAFE,
  REF_RE,
  RESERVED_EXACT,
  RESERVED_PREFIXES,
} from '../config/ownership';
import type { PatchOp } from '../config/patch';
import { pipelineDefs } from '../pipelines';
import { resolveVersion } from '../config/version';
import {
  HttpError,
  isRecord,
  modelIsInstalled,
  readJsonBody,
  recordField,
  requireAgent,
  respondError,
  runSave,
} from './http';

export const agentsRoute = new Hono();

// --- POST /api/agents gate constants (design D2) ----------------------------

/** AC-4: the ONLY keys a create may carry (first offender is named).
 * phase-agents-v3 (D7): `mode` joins the whitelist — subagent|primary|all. */
const ENTRY_FIELDS = new Set(['model', 'description', 'prompt', 'mode']);
/** D7 gate 6b: the mode whitelist. Everything else → 400 mode_invalid. */
const AGENT_MODES = new Set(['subagent', 'primary', 'all']);

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

/** Gate 8 (AC-6) — modelIsInstalled relocated to routes/http.ts in WU-2a
 * (shared with the pipeline endpoints); behavior-neutral for this route. */

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
    // 4. reserved-name blocklist (case-sensitive, AC-3) — phase-agents-v3:
    //    the gate is now the VERSION-GATED predicate (design D5). The
    //    resolution is memoized per (statePath, binary); at 3.x the 13
    //    exact roster names pass this gate (the install flow creates them);
    //    at 2.x/unknown the answer is byte-identical to the legacy check.
    //    Gate position is PINNED — reserved still precedes every later gate.
    const { mode: versionMode } = await resolveVersion();
    if (isReservedV3(name, versionMode)) {
      throw new HttpError(
        400,
        'reserved_name',
        `Agent name "${name}" is owned by gentle-ai sync (${RESERVED_PREFIXES.join('/')}* prefixes + ${[...RESERVED_EXACT].join(', ')}) — a next sync would silently deep-merge over it.`,
      );
    }
    // 5. agent must be a record.
    const entry = recordField(body, 'agent');
    // 6. entry keys ⊆ {model, description, prompt, mode} — name the first.
    for (const key of Object.keys(entry)) {
      if (!ENTRY_FIELDS.has(key)) {
        throw new HttpError(
          400,
          'unknown_field',
          `agent.${key} is not writable at create — only model, description, mode and prompt are accepted.`,
          { field: key },
        );
      }
    }
    // 6b. mode, when present, must be a whitelisted agent mode (D7). Sits
    //     BETWEEN the key-whitelist walk and the prompt gates; gate 4 still
    //     precedes it, so reserved name + invalid mode → reserved_name first.
    if (
      Object.hasOwn(entry, 'mode') &&
      (typeof entry['mode'] !== 'string' || !AGENT_MODES.has(entry['mode']))
    ) {
      throw new HttpError(
        400,
        'mode_invalid',
        `agent.mode "${String(entry['mode'])}" is not a valid agent mode — use subagent, primary or all.`,
        { field: 'mode' },
      );
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
    //    D7: mode joins the canonical build (model, description, mode, prompt).
    const value: Record<string, unknown> = {};
    if (typeof entry['model'] === 'string') value['model'] = entry['model'];
    if (typeof entry['description'] === 'string')
      value['description'] = entry['description'];
    if (typeof entry['mode'] === 'string') value['mode'] = entry['mode'];
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

// --- SCW-7' c: PUT /api/agents/:name/prompt (OA-4', AP-4 lockstep) ----------

/**
 * Prompt UPDATE for user-owned names (the entry itself stays create-once;
 * only the prompt value moves). Gates: requireAgent 404 → roster policy
 * (phase-agents-v3 D2: at 3.x the 13 roster names are create-once — a
 * DISTINCT roster_protected 400, model assignment stays available) →
 * reserved 400 (v3-aware: managed prompts never writable) → AC-5
 * (non-empty inline string, ≤ 64 KiB, WHOLE-STRING `{file:}` rejection —
 * mid-string stays inert text). A pipeline-owned ROLE answers with ONE
 * runSave carrying both the row value-op and the def-map whole write with
 * that roles[].prompt replaced — def/row match post-save (AP-4). The
 * orchestrator prompt is generator-owned: writes on its name 400; the
 * builder save regenerates it.
 */
agentsRoute.put('/agents/:name/prompt', async (c) => {
  try {
    const body = await readJsonBody(c);
    const name = c.req.param('name');
    const loaded = await requireAgent(name);
    // Route-level roster policy (design D2): 3.x && exact roster name →
    // roster_protected. In 2.x/unknown this never fires and the name falls
    // through to the legacy reserved gate — byte-identical semantics.
    const { mode: versionMode } = await resolveVersion();
    if (versionMode === '3.x' && isRosterProtected(name)) {
      throw new HttpError(
        400,
        'roster_protected',
        `Agent "${name}" is a 3.0 phase agent — its prompt is fixed at creation (create-once roster policy); model assignment remains available through the model endpoint.`,
        { name },
      );
    }
    if (isReservedV3(name, versionMode)) {
      throw new HttpError(
        400,
        'reserved_name',
        `Agent "${name}" is owned by gentle-ai sync — its prompt is never writable through the dashboard (OA-4).`,
      );
    }
    const prompt = body['prompt'];
    if (prompt === undefined || prompt === '') {
      throw new HttpError(
        400,
        'prompt_required',
        '"prompt" must be a non-empty inline string.',
      );
    }
    if (typeof prompt !== 'string') {
      throw new HttpError(400, 'prompt_invalid', '"prompt" must be a string.');
    }
    if (REF_RE.test(prompt)) {
      throw new HttpError(
        400,
        'file_ref_rejected',
        'A {file:…} reference prompt is never persisted — inline the text.',
      );
    }
    if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) {
      throw new HttpError(
        400,
        'prompt_too_large',
        `prompt is ${Buffer.byteLength(prompt, 'utf8')} bytes — the cap is 65536 (64 KiB).`,
      );
    }
    const owner = findPipelineOwner(loaded.tree, name);
    if (owner !== undefined && name === owner) {
      throw new HttpError(
        400,
        'generator_owned',
        `The orchestrator prompt of pipeline "${owner}" is generated from the role set — save the pipeline in the builder to regenerate it.`,
      );
    }
    if (owner !== undefined) {
      // AP-4 lockstep: row + definition in exactly one save (SCW-7' c).
      const defs = pipelineDefs(loaded.tree);
      const defRaw = defs[owner];
      const roles =
        isRecord(defRaw) && Array.isArray(defRaw['roles'])
          ? (defRaw['roles'] as unknown[])
          : [];
      const rewritten = roles.map((role) =>
        isRecord(role) && role['name'] === name
          ? { ...role, prompt } // existing key → position-preserving update
          : role,
      );
      const ops: PatchOp[] = [
        { path: ['agent', name, 'prompt'], value: prompt },
        {
          path: ['agent-pipelines'],
          value: {
            ...defs,
            [owner]: {
              ...(isRecord(defRaw) ? defRaw : {}),
              roles: rewritten,
            },
          },
        },
      ];
      return await runSave(c, body, ops);
    }
    return await runSave(c, body, [
      { path: ['agent', name, 'prompt'], value: prompt },
    ]);
  } catch (err) {
    return respondError(c, err);
  }
});

// --- SCW-7' d: DELETE /api/agents/:name (user-owned standalone only) --------

/**
 * Whole-entry DELETE confined to user-owned STANDALONE names: reserved names
 * never delete (sync owns them), pipeline members never delete standalone —
 * AP-5's pipeline delete removes def and rows together (definitions cannot
 * bypass the gate; patch()'s accumulated-tree check is the backstop). One
 * runSave, one remove op; SCW-4 backup inside; fresh hash echoed.
 */
agentsRoute.delete('/agents/:name', async (c) => {
  try {
    const body = await readJsonBody(c);
    const name = c.req.param('name');
    const loaded = await requireAgent(name); // absent/typo → 404 first
    // Route-level roster policy (design D2), immediately after requireAgent:
    // at 3.x a roster name is create-once — deletion is blocked with the
    // DISTINCT roster_protected code. 2.x/unknown falls through untouched.
    const { mode: versionMode } = await resolveVersion();
    if (versionMode === '3.x' && isRosterProtected(name)) {
      throw new HttpError(
        400,
        'roster_protected',
        `Agent "${name}" is a 3.0 phase agent — deletion is blocked (create-once roster policy); model assignment remains available through the model endpoint.`,
        { name },
      );
    }
    if (!NAME_RE.test(name) || NAME_UNSAFE.has(name)) {
      throw new HttpError(
        400,
        'name_invalid',
        `"${name}" is not a deletable name — must match ${NAME_RE}.`,
      );
    }
    if (isReservedV3(name, versionMode)) {
      throw new HttpError(
        400,
        'reserved_name',
        `Agent "${name}" is owned by gentle-ai sync — it is never deletable through the dashboard.`,
      );
    }
    const owner = findPipelineOwner(loaded.tree, name);
    if (owner !== undefined) {
      throw new HttpError(
        400,
        'pipeline_owned',
        `Agent "${name}" is a member of pipeline "${owner}" — delete the pipeline instead (its rows are removed atomically with the definition).`,
      );
    }
    return await runSave(c, body, [{ path: ['agent', name], remove: true }]);
  } catch (err) {
    return respondError(c, err);
  }
});
