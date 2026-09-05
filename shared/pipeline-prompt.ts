// agent-pipelines WU-1 task 1.8 — the pipeline prompt generator (AP-3,
// design §Prompt generator). Lives in shared/ as the SINGLE source so the
// server's materialized orchestrator row and the web builder's read-only
// preview render BYTE-IDENTICAL text and the SAME task map from one role
// set. Pure and deterministic: no fs, no Date, no random, no locale-sensitive
// formatting — identical bytes under node and the browser (SCW-6 order rule:
// insertion order everywhere, never sorted).
//
// The task map mirrors gentle-ai's orchestrator posture (C-R4) with two
// deliberate deltas: NO `__replace__` sentinel (user rows must deep-merge
// cleanly under sync, C-G1) and helpers are exact names, not globs. Key
// order is load-bearing: OpenCode's permission evaluation is LAST-match-wins
// (C-R1f), so `"*":"deny"` must precede every allow or the deny would win.

/** One role as the prompt sees it (subset of PipelineRoleDef). */
export interface OrchestratorPromptRole {
  name: string;
  description: string;
  /** Absent ⇒ documented as invoker-model inheritance (C-R1e). */
  model?: string;
}

/** Generator input — the definition's role set + helper names. */
export interface OrchestratorPromptInput {
  /** Pipeline key ≡ orchestrator row name (AP-6). */
  pipeline: string;
  roles: OrchestratorPromptRole[];
  helpers?: string[];
}

/** Generated `permission.task`: deny-star first, def order preserved. */
export function buildTaskPermissionMap(
  roles: readonly string[],
  helpers: readonly string[] = [],
): Record<string, 'deny' | 'allow'> {
  const task: Record<string, 'deny' | 'allow'> = { '*': 'deny' };
  for (const name of roles) task[name] = 'allow';
  for (const name of helpers) task[name] = 'allow';
  return task;
}

/**
 * Generated orchestrator-row permission (C-R4 mirror): the coordinator may
 * ask the user questions and delegate ONLY by exact name.
 */
export function buildOrchestratorPermission(
  roles: readonly string[],
  helpers: readonly string[] = [],
): {
  question: 'allow';
  task: Record<string, 'deny' | 'allow'>;
} {
  return { question: 'allow', task: buildTaskPermissionMap(roles, helpers) };
}

/**
 * Render the orchestrator prompt (AP-3). Modest by design — gentle-ai's own
 * orchestrator prompt is hand-authored; this one states the contract: exact
 * names only, roles with their models, helpers as delegatable extras.
 */
export function buildOrchestratorPrompt(
  input: OrchestratorPromptInput,
): string {
  const { pipeline, roles, helpers = [] } = input;
  const lines: string[] = [
    `You are \`${pipeline}\`, the "${pipeline}" pipeline coordinator.`,
    '',
    'Delegate every task through the Task tool, addressing subagents ONLY by',
    'the exact names listed below. Never invent, guess or substitute a name —',
    'delegations to anything unlisted are denied at runtime.',
    '',
    '## Roles',
  ];
  for (const role of roles) {
    const model =
      role.model === undefined
        ? 'model: inherited from the invoker conversation'
        : `model: ${role.model}`;
    lines.push(`- \`${role.name}\` — ${role.description} (${model})`);
  }
  if (helpers.length > 0) {
    lines.push(
      '',
      '## Helpers',
      'When a listed helper is the right tool, delegate to it by exact name:',
    );
    for (const helper of helpers) lines.push(`- \`${helper}\``);
  }
  lines.push(
    '',
    'Coordinate: split work across the roles above, relay each role its',
    'context, and integrate the results yourself — you own the outcome.',
  );
  return lines.join('\n');
}
