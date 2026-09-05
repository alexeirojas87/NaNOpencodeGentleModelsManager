// WU3.4 — validation (SCW-3 pre-backup gate, CX-4 offline).
// validate(tree) runs the generated permissive schema (shared/
// schema.generated.ts — derived from opencode.ai/config.json, unknown keys
// NEVER rejected) and adds a small domain addendum: the spec ModelConfig
// superset (Definitions / MC-1) includes `contextWindow`, which upstream does
// NOT declare (models use `limit` there), so the schema alone cannot reject a
// `contextWindow: "1M"`-style edit. The addendum closes exactly that gap,
// generically over 0..N providers and model ids (PC-4).
//
// Output is a list of readable per-path issues; an empty list means valid.
// Callers (WU4 save, WU5 routes) map a non-empty list to HTTP 400 pre-backup.
import { z } from 'zod';

import { configSchema } from '../../../shared/schema.generated';
import { MAX_PROMPT_BYTES, NAME_RE, NAME_UNSAFE, REF_RE } from './ownership';

export interface ValidationIssue {
  /** Dot path to the offending key, e.g. provider.nan.models.x.contextWindow. */
  path: string;
  /** Human-readable, single-line explanation. */
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Spec-defined ModelConfig fields that the upstream schema does not declare
 * and therefore cannot enforce. Keep in sync with shared/types.ts ModelConfig.
 */
function contextWindowIssues(tree: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const provider = isRecord(tree) ? tree.provider : undefined;
  if (!isRecord(provider)) return issues;
  // Generic over 0..N ids — malformed sections are skipped, never thrown on.
  for (const [id, section] of Object.entries(provider)) {
    if (!isRecord(section)) continue;
    const models = section.models;
    if (!isRecord(models)) continue;
    for (const [modelId, model] of Object.entries(models)) {
      if (!isRecord(model) || !('contextWindow' in model)) continue;
      const value = model.contextWindow;
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        issues.push({
          path: `provider.${id}.models.${modelId}.contextWindow`,
          message: `expected a finite number of tokens, got ${JSON.stringify(value)}`,
        });
      }
    }
  }
  return issues;
}

/**
 * AP-1 (agent-pipelines): the definition map is DASHBOARD-OWNED, so unlike the
 * passthrough sections it is policed by a STRICT zod schema — no-unrecognized-
 * keys at every level, anchored whole-string `{file:` rejection (mid-string is
 * inert text, OA-4'), non-empty prompts ≤ 64 KiB, AC-2 charset pipeline keys,
 * and helper names that can never smuggle glob metas (`*`/`?` would widen the
 * generated permission.task beyond its exact-name allow contract).
 */
const promptSchema = z
  .string()
  .min(1)
  .refine((p) => !REF_RE.test(p), {
    message: 'a {file:…} reference prompt is never persisted — inline the text',
  })
  .refine((p) => Buffer.byteLength(p, 'utf8') <= MAX_PROMPT_BYTES, {
    message: `prompt exceeds the ${MAX_PROMPT_BYTES} byte (64 KiB) cap`,
  });

const pipelineKeySchema = z
  .string()
  .refine((k) => NAME_RE.test(k) && !NAME_UNSAFE.has(k), {
    message:
      'pipeline/role/helper names must match ^[\\w.-]+$ and not be . / .. / __proto__ / constructor / prototype',
  });

const agentPipelinesSchema = z.record(
  pipelineKeySchema,
  z.strictObject({
    roles: z.array(
      z.strictObject({
        name: pipelineKeySchema,
        model: z.string().optional(),
        description: z.string(),
        promptSource: z.enum(['template', 'clone', 'free-text']),
        prompt: promptSchema,
      }),
    ),
    orchestrator: z.strictObject({
      model: z.string().optional(),
      description: z.string(),
    }),
    helpers: z.array(pipelineKeySchema).optional(),
  }),
);

/** Issues for one submitted definition map, standalone (route pre-disk gate
 * per AP-1 — same authority as save-time section validation, zero duplication;
 * pass `{ [key]: def }`). */
export function pipelineSectionIssuesOf(section: unknown): ValidationIssue[] {
  const parsed = agentPipelinesSchema.safeParse(section);
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => ({
    path: `agent-pipelines${issue.path.length > 0 ? `.${issue.path.map(String).join('.')}` : ''}`,
    message: issue.message,
  }));
}

/** Issues for the dashboard-owned definition map (strict, per AP-1). */
function pipelineSectionIssues(
  tree: Record<string, unknown>,
): ValidationIssue[] {
  const section = tree['agent-pipelines'];
  if (section === undefined) return [];
  return pipelineSectionIssuesOf(section);
}

/**
 * Sections the Allowlist can write to. Only these are policed: everything
 * else in CONFIG is externally owned, survives every write untouched (SCW-7)
 * and pre-existing drift there must never block an allowlisted save — the
 * dashboard validates what it changes and repairs nothing (PC-1 spirit).
 * `agent-pipelines` is policed by the STRICT agentPipelinesSchema above (its
 * projection through the permissive generated schema below is a no-op —
 * dashboard content must reject unknown keys, externally owned content may not).
 */
const WRITABLE_SECTIONS = [
  'provider',
  'agent',
  'default_agent',
  'agent-pipelines',
] as const;

/** Validate a CONFIG tree: writable sections against schema + domain addendum. */
export function validate(tree: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!isRecord(tree)) {
    return [{ path: '', message: 'CONFIG root must be a JSON object' }];
  }

  // Project to the writable sections before schema parsing so issues from
  // non-writable (externally owned) subtrees cannot appear. Root level of
  // the generated schema is permissive, so projected keys keep their
  // full-tree paths (provider…, agent…, default_agent).
  const writable: Record<string, unknown> = {};
  for (const section of WRITABLE_SECTIONS) {
    if (section in tree) writable[section] = tree[section];
  }

  const parsed = configSchema.safeParse(writable);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.map(String).join('.');
      issues.push({ path, message: issue.message });
    }
  }

  issues.push(...pipelineSectionIssues(tree));
  return issues.concat(contextWindowIssues(tree));
}
