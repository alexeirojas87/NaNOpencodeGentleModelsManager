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
import { configSchema } from '../../../shared/schema.generated';

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
 * Sections the Allowlist can write to. Only these are policed: everything
 * else in CONFIG is externally owned, survives every write untouched (SCW-7)
 * and pre-existing drift there must never block an allowlisted save — the
 * dashboard validates what it changes and repairs nothing (PC-1 spirit).
 */
const WRITABLE_SECTIONS = ['provider', 'agent', 'default_agent'] as const;

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

  return issues.concat(contextWindowIssues(tree));
}
