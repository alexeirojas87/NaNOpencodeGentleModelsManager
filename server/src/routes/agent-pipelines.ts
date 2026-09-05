// agent-pipelines WU-2a task 2a.3 — pipeline lifecycle endpoints (design
// §API shape): POST /api/agent-pipelines, PUT/DELETE /api/agent-pipelines/:name.
// EVERY gate runs pre-disk against the accumulated in-memory view of the base
// CONFIG (AC-2/AC-3 per referenced name, AP-1 shape via the shared zod
// authority, AC-4' input whitelist, AP-2 intra-batch dup/collision, AP-4/5
// cross-pipeline ownership) and a passing batch rides EXACTLY ONE runSave —
// one-save/zero-mutation on any gate failure (SCW-1/SCW-7a).
import { Hono } from 'hono';

import type {
  AgentPipelinesResponse,
  ConfigTree,
  PipelineDefinition,
} from '../../../shared/types';
import {
  isReserved,
  isUserOwned,
  NAME_RE,
  NAME_UNSAFE,
} from '../config/ownership';
import { load } from '../config/load';
import {
  buildCreateOps,
  buildDeleteOps,
  buildEditOps,
  memberNames,
  otherPipelineOwner,
  pipelineDefs,
} from '../pipelines';
import { pipelineSectionIssuesOf } from '../config/validate';
import {
  HttpError,
  isRecord,
  modelIsInstalled,
  readJsonBody,
  respondError,
  runSave,
} from './http';

export const agentPipelinesRoute = new Hono();

/** Deterministic charset gate (threat name/path injection). */
function nameGate(name: unknown, what: string): string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new HttpError(
      400,
      'name_invalid',
      `${what} must be a non-empty string.`,
    );
  }
  if (!NAME_RE.test(name) || NAME_UNSAFE.has(name)) {
    throw new HttpError(
      400,
      'name_invalid',
      `${what} "${name}" is not a valid name — must match ${NAME_RE} and must not be . / .. / __proto__ / constructor / prototype.`,
    );
  }
  // Integer-like keys would float to the front of the serialized permission
  // task map (JS integer-key ordering), silently breaking deny-star-first
  // under C-R1f last-match-wins. Rejected pre-disk, zero mutation.
  if (/^\d+$/.test(name)) {
    throw new HttpError(
      400,
      'name_invalid',
      `${what} "${name}" is not allowed — integer-like names would reorder the generated task map.`,
    );
  }
  return name;
}

function reservedGate(name: string): void {
  if (isReserved(name)) {
    throw new HttpError(
      400,
      'reserved_name',
      `Agent name "${name}" is owned by gentle-ai sync — a pipeline may not claim it.`,
    );
  }
}

/** AC-4': the generated-fields trio never rides client input (first offender
 * named); every other shape question belongs to the strict AP-1 zod. */
function generatedFieldGate(
  entry: Record<string, unknown>,
  label: string,
): void {
  for (const field of ['mode', 'hidden', 'permission']) {
    if (Object.hasOwn(entry, field)) {
      throw new HttpError(
        400,
        'unknown_field',
        `${label}.${field} is server-generated for pipeline rows — the builder derives it from the role set.`,
        { field },
      );
    }
  }
}

/** Tolerant read of a STORED def (externally-authored CONFIG may deviate;
 * member bookkeeping only needs the claimed role names). */
function normalizeDef(raw: unknown): PipelineDefinition {
  const def = isRecord(raw) ? raw : {};
  const roles = Array.isArray(def['roles']) ? def['roles'] : [];
  return {
    roles: roles
      .filter(
        (r): r is Record<string, unknown> =>
          isRecord(r) && typeof r['name'] === 'string',
      )
      .map((r) => ({
        name: r['name'] as string,
        description:
          typeof r['description'] === 'string' ? r['description'] : '',
        promptSource: 'template',
        prompt: typeof r['prompt'] === 'string' ? r['prompt'] : '',
      })),
    orchestrator: { description: '' },
  };
}

interface GateResult {
  key: string;
  def: PipelineDefinition;
}

/** Full pre-disk gate chain shared by POST and PUT. `editing` admits this
 * pipeline's OWN current members as rewrite targets (they ride the paired
 * remove+insert of buildEditOps); everything else must be collision-free. */
async function gatePipeline(
  body: Record<string, unknown>,
  pathName: string | undefined,
  baseTree: ConfigTree,
  editing: boolean,
): Promise<GateResult> {
  const pipeline = body['pipeline'];
  if (!isRecord(pipeline)) {
    throw new HttpError(
      400,
      'bad_request',
      'Body must carry a "pipeline" object.',
    );
  }
  for (const key of Object.keys(pipeline)) {
    if (!['name', 'orchestrator', 'roles', 'helpers'].includes(key)) {
      throw new HttpError(
        400,
        'unknown_field',
        `pipeline.${key} is not accepted — the builder submits name, orchestrator, roles and helpers only.`,
        { field: key },
      );
    }
  }
  const key = nameGate(pipeline['name'], 'Pipeline name');
  if (pathName !== undefined && pathName !== key) {
    throw new HttpError(
      400,
      'name_invalid',
      `Path pipeline "${pathName}" does not match body name "${key}".`,
    );
  }
  if (!isUserOwned(key)) {
    throw new HttpError(
      400,
      'reserved_name',
      `Pipeline name "${key}" collides with a gentle-ai sync-managed agent (the orchestrator row carries this name).`,
    );
  }
  if (!isRecord(pipeline['orchestrator'])) {
    throw new HttpError(
      400,
      'bad_request',
      'pipeline.orchestrator must be an object.',
    );
  }
  generatedFieldGate(pipeline['orchestrator'], 'pipeline.orchestrator');
  if (!Array.isArray(pipeline['roles'])) {
    throw new HttpError(400, 'bad_request', 'pipeline.roles must be an array.');
  }
  const seen = new Set<string>([key]); // orchestrator ≡ pipeline key (AP-6)
  for (const [i, role] of (pipeline['roles'] as unknown[]).entries()) {
    if (!isRecord(role)) {
      throw new HttpError(
        400,
        'bad_request',
        `pipeline.roles[${i}] must be an object.`,
      );
    }
    generatedFieldGate(role, `pipeline.roles[${i}]`);
    const roleName = nameGate(role['name'], `pipeline.roles[${i}].name`);
    reservedGate(roleName);
    if (seen.has(roleName)) {
      throw new HttpError(
        400,
        'duplicate_name',
        `Role name "${roleName}" appears twice in this batch — every member name must be unique.`,
      );
    }
    seen.add(roleName);
  }
  const helpers = pipeline['helpers'];
  if (helpers !== undefined) {
    if (!Array.isArray(helpers) || helpers.some((h) => typeof h !== 'string')) {
      throw new HttpError(
        400,
        'bad_request',
        'pipeline.helpers must be an array of names.',
      );
    }
    for (const helper of helpers as string[]) {
      // Charset/glob metas are policed by the strict zod below (invalid_shape
      // names the path); the integer-key hazard gets the same name_invalid.
      if (/^\d+$/.test(helper)) nameGate(helper, 'Helper name');
    }
  }
  // Collision and cross-pipeline ownership for every member this batch writes.
  const agentSection = isRecord(baseTree['agent']) ? baseTree['agent'] : {};
  const ownMembers = new Set(
    editing ? memberNames(key, normalizeDef(pipelineDefs(baseTree)[key])) : [],
  );
  for (const name of seen) {
    const other = otherPipelineOwner(baseTree, key, name);
    if (other !== undefined) {
      throw new HttpError(
        400,
        'pipeline_owned',
        `Agent "${name}" is already a member of pipeline "${other}" — a name belongs to exactly one pipeline.`,
      );
    }
    if (Object.hasOwn(agentSection, name) && !ownMembers.has(name)) {
      throw new HttpError(
        400,
        'agent_exists',
        `Agent "${name}" already exists outside this pipeline — choose a different member name.`,
      );
    }
  }
  // AP-1 shape via the shared zod authority (the same gate validate() enforces
  // inside SCW-3 — the route answers 400 naming the path, pre-disk).
  const def = {
    roles: pipeline['roles'],
    orchestrator: pipeline['orchestrator'],
    ...(helpers !== undefined ? { helpers } : {}),
  } as unknown as PipelineDefinition;
  const issues = pipelineSectionIssuesOf({ [key]: def });
  if (issues.length > 0) {
    const first = issues[0];
    throw new HttpError(400, 'invalid_shape', 'Pipeline definition rejected.', {
      issues,
      field: first?.path,
      detail: `${first?.path}: ${first?.message}`,
    });
  }
  // AC-6 installed-pair rule on every optional model the batch carries.
  const models: [string, unknown][] = [
    ['pipeline.orchestrator.model', def.orchestrator.model],
    ...def.roles.map(
      (r, i) => [`pipeline.roles[${i}].model`, r.model] as [string, unknown],
    ),
  ];
  for (const [label, model] of models) {
    if (model !== undefined && !(await modelIsInstalled(model))) {
      throw new HttpError(
        400,
        'model_unknown',
        `${label} "${String(model)}" is not a "<provider>/<model-id>" pair installed in CONFIG — omit it to inherit the invoker model.`,
      );
    }
  }
  return { key, def };
}

/**
 * GET /api/agent-pipelines — the definition READ surface (batch-1 deviation 1
 * resolution, apply-progress #479): design #472 said definitions ride
 * GET /api/config, but that response is pinned by routes.test.ts to an exact
 * key set; a read-only route keeps both intact. Raw, tolerant pass-through of
 * the CONFIG map — reads never validate (shape policing is the WRITE gates'
 * job; an externally-authored entry mirrors back as stored). No auth beyond
 * CX-1: the whole API is local-only.
 */
agentPipelinesRoute.get('/agent-pipelines', async (c) => {
  try {
    const loaded = await load();
    const body: AgentPipelinesResponse = {
      pipelines: pipelineDefs(loaded.tree) as Record<
        string,
        PipelineDefinition
      >,
    };
    return c.json(body);
  } catch (err) {
    return respondError(c, err);
  }
});

agentPipelinesRoute.post('/agent-pipelines', async (c) => {
  try {
    const body = await readJsonBody(c);
    const loaded = await load();
    // Safe pre-read so an existing def answers pipeline_exists, not the
    // collision walk on its own orchestrator row (agent_exists).
    const candidate = isRecord(body['pipeline'])
      ? body['pipeline']['name']
      : undefined;
    if (
      typeof candidate === 'string' &&
      Object.hasOwn(pipelineDefs(loaded.tree), candidate)
    ) {
      throw new HttpError(
        400,
        'pipeline_exists',
        `Pipeline "${candidate}" already exists — edit it (PUT) or delete it first.`,
      );
    }
    const { key, def } = await gatePipeline(
      body,
      undefined,
      loaded.tree,
      false,
    );
    if (Object.hasOwn(pipelineDefs(loaded.tree), key)) {
      throw new HttpError(
        400,
        'pipeline_exists',
        `Pipeline "${key}" already exists — edit it (PUT) or delete it first.`,
      );
    }
    return await runSave(c, body, buildCreateOps(loaded.tree, key, def));
  } catch (err) {
    return respondError(c, err);
  }
});

agentPipelinesRoute.put('/agent-pipelines/:name', async (c) => {
  try {
    const body = await readJsonBody(c);
    const pathName = c.req.param('name');
    const loaded = await load();
    const defs = pipelineDefs(loaded.tree);
    if (!Object.hasOwn(defs, pathName)) {
      throw new HttpError(
        404,
        'pipeline_not_found',
        `Pipeline "${pathName}" has no definition in CONFIG — create it first.`,
      );
    }
    const { key, def } = await gatePipeline(body, pathName, loaded.tree, true);
    const ops = buildEditOps(loaded.tree, key, normalizeDef(defs[key]), def);
    return await runSave(c, body, ops);
  } catch (err) {
    return respondError(c, err);
  }
});

agentPipelinesRoute.delete('/agent-pipelines/:name', async (c) => {
  try {
    const body = await readJsonBody(c);
    const pathName = c.req.param('name');
    const loaded = await load();
    const defs = pipelineDefs(loaded.tree);
    if (!Object.hasOwn(defs, pathName)) {
      throw new HttpError(
        404,
        'pipeline_not_found',
        `Pipeline "${pathName}" has no definition in CONFIG — nothing to delete.`,
      );
    }
    const ops = buildDeleteOps(
      loaded.tree,
      pathName,
      normalizeDef(defs[pathName]),
    );
    return await runSave(c, body, ops);
  } catch (err) {
    return respondError(c, err);
  }
});
