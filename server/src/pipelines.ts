// agent-pipelines WU-2a task 2a.2 — pure pipeline materializer (AP-2/AP-3/
// AP-4/AP-5, design §Materializer + ops array). buildPipelineOps turns a
// validated definition + the base tree into the EXACT PatchOp batch for one
// runSave; genRow produces the runtime rows. Zero IO, zero gates — routes
// decide content (AC-2/3/5/6, dup/collision), this module only materializes.
//
// Batch shapes (design delete-ordering rule — decisive under patch()'s
// accumulated-tree gates):
//   create: [def-map write, orchestrator insert, role inserts…]
//   edit:   [def-map write, removes(old members), inserts(new members…)]
//   delete: [def-map write minus the entry, removes(members of removed def)]
// The def-map write runs FIRST everywhere: an edit's rewrite removes are
// admitted by their paired inserts (SCW-7b builder posture); a delete's
// removes are admitted because the def already stopped claiming them.
import {
  buildOrchestratorPermission,
  buildOrchestratorPrompt,
} from '../../shared/pipeline-prompt';
import type { PipelineDefinition, PipelineRoleDef } from '../../shared/types';
import type { ConfigTree } from './config/load';
import type { PatchOp } from './config/patch';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Definition map of a (possibly absent/externally shaped) CONFIG tree. */
export function pipelineDefs(tree: ConfigTree): Record<string, unknown> {
  return isRecord(tree['agent-pipelines']) ? tree['agent-pipelines'] : {};
}

/** Member row names a def materializes: orchestrator (≡ key) + every role. */
export function memberNames(key: string, def: PipelineDefinition): string[] {
  return [key, ...def.roles.map((r) => r.name)];
}

/**
 * Member row names claimed by any OTHER definition (route collision gate:
 * a name owned elsewhere must 400 pipeline_owned, never silently ride the
 * leafPresent collision as agent_exists). Own-key semantics match
 * findPipelineOwner: a present map key claims its own name as orchestrator.
 */
export function otherPipelineOwner(
  tree: ConfigTree,
  pipelineKey: string,
  name: string,
): string | undefined {
  for (const [key, def] of Object.entries(pipelineDefs(tree))) {
    if (key === pipelineKey) continue;
    if (key === name) return key;
    if (isRecord(def) && Array.isArray(def['roles'])) {
      for (const role of def['roles']) {
        if (isRecord(role) && role['name'] === name) return key;
      }
    }
  }
  return undefined;
}

/**
 * One materialized row. Generated fields (mode/hidden/permission/prompt for
 * the orchestrator) are builder-only (AC-4': clients never supply them);
 * `temperature`/`variant` are NEVER emitted (AP-2). Absent model keys stay
 * absent — invoker inheritance at delegation (C-R1e), nothing invented.
 */
export function genRow(
  pipelineKey: string,
  def: PipelineDefinition,
  role?: PipelineRoleDef,
): Record<string, unknown> {
  const model = typeof role?.model === 'string' ? { model: role.model } : {};
  if (role) {
    return {
      mode: 'subagent',
      hidden: true,
      description: role.description,
      ...model,
      prompt: role.prompt,
    };
  }
  const roles = def.roles.map((r) => ({
    name: r.name,
    description: r.description,
    ...(typeof r.model === 'string' ? { model: r.model } : {}),
  }));
  const orchModel =
    typeof def.orchestrator.model === 'string'
      ? { model: def.orchestrator.model }
      : {};
  return {
    mode: 'primary',
    description: def.orchestrator.description,
    ...orchModel,
    prompt: buildOrchestratorPrompt({
      pipeline: pipelineKey,
      roles,
      helpers: def.helpers ?? [],
    }),
    permission: buildOrchestratorPermission(
      def.roles.map((r) => r.name),
      def.helpers ?? [],
    ),
  };
}

/** Definition entry exactly as persisted (AP-1 shape; generated fields ride
 * the ROWS only — the def keeps the generator inputs verbatim). */
function defEntry(input: PipelineDefinition): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    roles: input.roles.map((r) => {
      const role: Record<string, unknown> = {
        name: r.name,
        ...(typeof r.model === 'string' ? { model: r.model } : {}),
        description: r.description,
        promptSource: r.promptSource,
        prompt: r.prompt,
      };
      return role;
    }),
    orchestrator: {
      ...(typeof input.orchestrator.model === 'string'
        ? { model: input.orchestrator.model }
        : {}),
      description: input.orchestrator.description,
    },
  };
  if (Array.isArray(input.helpers) && input.helpers.length > 0) {
    entry['helpers'] = [...input.helpers];
  }
  return entry;
}

/** Whole-value def-map op carrying (or first removing) `key`. */
function defMapOp(
  tree: ConfigTree,
  key: string,
  def: PipelineDefinition | undefined,
): PatchOp {
  const map: Record<string, unknown> = { ...pipelineDefs(tree) };
  if (def === undefined) delete map[key];
  else map[key] = defEntry(def);
  return { path: ['agent-pipelines'], value: map };
}

/** CREATE: def-map write then insert rows (orchestrator + roles, batch order
 * kept; patch()'s loop turns any present leaf into 400 agent_exists). */
export function buildCreateOps(
  tree: ConfigTree,
  key: string,
  def: PipelineDefinition,
): PatchOp[] {
  const ops: PatchOp[] = [defMapOp(tree, key, def)];
  ops.push({ path: ['agent', key], value: genRow(key, def), insert: true });
  for (const role of def.roles) {
    ops.push({
      path: ['agent', role.name],
      value: genRow(key, def, role),
      insert: true,
    });
  }
  return ops;
}

/** EDIT: def-map write, removes for every old member, regenerated inserts
 * for every new member — one save, def and rows in lockstep (AP-4). */
export function buildEditOps(
  tree: ConfigTree,
  key: string,
  oldDef: PipelineDefinition,
  def: PipelineDefinition,
): PatchOp[] {
  const ops: PatchOp[] = [defMapOp(tree, key, def)];
  for (const name of memberNames(key, oldDef)) {
    ops.push({ path: ['agent', name], remove: true });
  }
  ops.push({ path: ['agent', key], value: genRow(key, def), insert: true });
  for (const role of def.roles) {
    ops.push({
      path: ['agent', role.name],
      value: genRow(key, def, role),
      insert: true,
    });
  }
  return ops;
}

/** DELETE: def-map write WITHOUT the entry FIRST, then every member remove
 * (accumulated-tree admission) — zero orphans either direction (AP-5). */
export function buildDeleteOps(
  tree: ConfigTree,
  key: string,
  def: PipelineDefinition,
): PatchOp[] {
  const ops: PatchOp[] = [defMapOp(tree, key, undefined)];
  for (const name of memberNames(key, def)) {
    ops.push({ path: ['agent', name], remove: true });
  }
  return ops;
}
