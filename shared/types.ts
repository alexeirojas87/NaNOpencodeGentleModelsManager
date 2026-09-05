// WU3.2 — shared contracts (MC-1, PC-2/CX-2 masked DTOs).
// This module refines the local ConfigTree placeholder from
// server/src/config/load.ts. The LIVE tree stays structurally permissive:
// CONFIG is externally owned JSON, so shape is enforced at runtime by
// validate() + the generated schema (SCW-3/SCW-7), not by TypeScript.
// Strict typing lives where the dashboard controls the data: ModelConfig
// entries and the masked outbound DTOs consumed by the API (WU5) and UI.
import type { configSchema } from './schema.generated';

/** Parsed CONFIG as an insertion-ordered JSON object tree (SCW-6 order rule). */
export interface ConfigTree {
  $schema?: string;
  provider?: Record<string, unknown>;
  default_agent?: string;
  agent?: Record<string, unknown>;
  /** Pipeline definitions (AP-1): editing/provenance truth — `agent.*` rows
   * stay the runtime truth. Inert to OpenCode decode, sync-merge-surviving
   * (C-R2/C-G1); shape-policed by validate's strict agentPipelinesSchema. */
  'agent-pipelines'?: Record<string, PipelineDefinition>;
  [key: string]: unknown;
}

/** Type of the generated permissive schema (shared/schema.generated.ts). */
export type OpenCodeConfigSchema = typeof configSchema;

/**
 * ModelConfig — official OpenCode model-entry superset (spec Definitions).
 * Absent optional fields render as absent and are never invented on save
 * (MC-1); the index signature carries fields upstream doesn't declare yet
 * (e.g. `contextWindow`, absent from opencode.ai/config.json) passthrough.
 */
export interface ModelCost {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  context_over_200k?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
  };
  [key: string]: unknown;
}

export interface ModelModalities {
  input?: string[];
  output?: string[];
  [key: string]: unknown;
}

export interface ModelConfig {
  id?: string;
  name?: string;
  family?: string;
  /** Declared context size in tokens (spec ModelConfig; upstream omits it — validated by the domain addendum in validate.ts). */
  contextWindow?: number;
  attachment?: boolean;
  reasoning?: boolean;
  /** Per-model temperature SUPPORT flag (boolean upstream); distinct from agent temperature (number). */
  temperature?: boolean;
  tool_call?: boolean;
  interleaved?: boolean | string | { field?: string };
  cost?: ModelCost;
  release_date?: string;
  modalities?: ModelModalities;
  [key: string]: unknown;
}

/** Typed view of one `provider.<id>` entry (live tree may deviate — runtime validation governs). */
export interface ProviderConfig {
  name?: string;
  npm?: string;
  options?: { baseURL?: string; [key: string]: unknown };
  models?: Record<string, ModelConfig>;
  [key: string]: unknown;
}

/** Typed view of one `agent.<name>` entry; prompt bodies are read-only (OA-4). */
export interface AgentConfigEntry {
  model?: string;
  description?: string;
  temperature?: number;
  variant?: string;
  prompt?: string;
  /** agent-pipelines (AP-2): server-generated pipeline-row fields. Plain
   * OpenCode keys — the web surfaces them for grouping/gating (mode/hidden). */
  mode?: string;
  hidden?: boolean;
  [key: string]: unknown;
}

/**
 * Masked apiKey stand-in — mirrors mask.ts ApiKeyPresence semantics exactly:
 * non-empty string → {configured:true}; empty/non-string → {configured:false};
 * ABSENT key stays absent (nothing is invented — MC-1 consistency).
 */
export interface ApiKeyPresence {
  configured: boolean;
}

/** `provider.<id>.options` as it appears in masked API payloads (PC-2, CX-2). */
export interface MaskedProviderOptions {
  baseURL?: string;
  apiKey?: ApiKeyPresence;
  [key: string]: unknown;
}

/** Masked `provider.<id>` entry (apiKey value never present — CX-2). */
export interface MaskedProvider {
  name?: string;
  npm?: string;
  options?: MaskedProviderOptions;
  models?: Record<string, ModelConfig>;
  [key: string]: unknown;
}

/** Masked whole-tree view: everything maskConfig() outputs, typed. */
export interface MaskedConfigTree {
  $schema?: string;
  provider?: Record<string, MaskedProvider>;
  default_agent?: string;
  agent?: Record<string, AgentConfigEntry>;
  [key: string]: unknown;
}

/** GET /api/config response envelope (masked; design §API-Surface). */
export interface ConfigResponse {
  hash: string;
  /** epoch milliseconds of the CONFIG file at load time. */
  mtime: number;
  providers: Record<string, MaskedProvider>;
  /** Every `agent.*` entry projected generically — 0..N, no hardcoded subset (OA-1). */
  agents: Record<string, AgentConfigEntry>;
  defaultAgent?: string;
  /** auth.json is referenced by existence only — never values (out-of-scope summary). */
  authJson: { exists: string[] };
  /** `asOf` of the bundled NaN snapshot, or null when unavailable. */
  snapshotAsOf: string | null;
}

/** Write endpoints: echo the post-save hash on success (SCW-1 restart notice rides CX-3 UI). */
export interface WriteResponse {
  ok: true;
  hash: string;
}

/**
 * POST /api/sync response (design §API-Surface, OA-3). The gentle-ai sync
 * CLI's exit code and output ship verbatim; `hash` is present ONLY after an
 * exit-0 run, carrying the reloaded CONFIG base so the client re-baselines
 * without racing its own follow-up GET. A non-zero exit ships NO hash — the
 * dashboard must not claim a success state for a failed sync.
 */
export interface SyncResponse {
  ok: true;
  /** Process exit code of the sync run; 0 is the only success state. */
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Fresh CONFIG hash after a successful (exit-0) reload; absent on failure. */
  hash?: string;
}

/**
 * GET /api/status response envelope (design §API-Surface).
 * WU7 fills `drift`/`snapshotAsOf` from the bundled NaN snapshot; `backups`
 * lists restore points newest-first (SCW-4).
 */
export interface StatusResponse {
  /** Resolved CONFIG path (sandbox-aware via CONFIG_PATH). */
  path: string;
  /** Current content hash — same staleness signal as GET /api/config. */
  hash: string;
  /** CONFIG mtime in epoch milliseconds. */
  mtime: number;
  /** Declared-vs-snapshot drift cells (WU7) — advisory only, never blocks. */
  drift: DriftCell[];
  /** `asOf` of the bundled snapshot; null only if the bundle were absent. */
  snapshotAsOf: string | null;
  /** Backup file paths, newest first. */
  backups: string[];
  /** True once this server process has written CONFIG (CX-3 carrier). */
  restartRequired: boolean;
}

/**
 * One declared-vs-snapshot drift cell (MC-5). `advisory` is structurally
 * true: drift NEVER rewrites the declared value and NEVER blocks a save —
 * the save pipeline does not consult drift at all.
 */
export interface DriftCell {
  /** CONFIG provider id the declaration lives under (data, not a match key). */
  provider: string;
  /** Model id whose declared field differs from the snapshot. */
  model: string;
  /** Drifted field (currently only contextWindow — the docs quota). */
  field: string;
  /** Value declared in CONFIG — always wins on save (user override). */
  declared: number;
  /** Bundled snapshot value shown side-by-side (never applied). */
  snapshot: number;
  advisory: true;
}

/**
 * Snapshot model entry — docs metadata + quota from the bundled NaN catalog
 * (spec Definitions: Snapshot). Deliberately NO pricing: NaN publishes
 * quotas/rate-limits instead. Fields the docs record are present; fields it
 * does not are absent — never invented (MC-1 consistency).
 */
export interface SnapshotModelEntry {
  name?: string;
  kind?: string;
  /** Context quota in tokens (numeric drift oracle for MC-5). */
  contextWindow?: number;
  /** Raw docs label ('1M', '262K native') — display/provenance only. */
  contextDocs?: string;
  modalities?: ModelModalities;
  /** Per-member quota, where the docs publish one. */
  quota?: Record<string, unknown>;
  /** Free-form docs metadata (size/params, license, tier, capabilities). */
  docs?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Provider match metadata for the snapshot (drift rules): a CONFIG provider
 * gets snapshot data only when its npm package AND display name match this
 * pair. The provider ID is never a key — ids are user-owned (PC-4).
 */
export interface CatalogProviderMatch {
  npm: string;
  name: string;
}

/** GET /api/catalog response — the bundled offline snapshot document (CX-4). */
export interface CatalogResponse {
  asOf: string;
  provider: CatalogProviderMatch;
  models: Record<string, SnapshotModelEntry>;
  provenance?: Record<string, unknown>;
}

// --- orchestration-v2 WU-A: agent creation, templates, prompt resolve --------

/**
 * One bundled create preset (AT-1). `prompt` is always a non-empty INLINE
 * string — presets never carry `{file:…}` refs or gentle-ai markers, so a
 * created entry can't drift against sync-managed files (design D3).
 */
export interface AgentTemplate {
  id: 'reviewer' | 'executor' | 'orchestrator' | 'blank';
  label: string;
  description: string;
  prompt: string;
}

/** GET /api/templates response — exactly the 4 bundled presets (AT-1). */
export interface TemplatesResponse {
  templates: AgentTemplate[];
}

/**
 * POST /api/agents body (AC-1): a create-only whole-entry write. `agent`
 * carries only {model?, description?, prompt}; prompt is required, inline
 * and ≤ 64 KiB (AC-4/AC-5). There is deliberately NO update route — the
 * entry is set at creation and never rewritten through the API (OA-4).
 */
export interface CreateAgentRequest {
  hash: string;
  name: string;
  agent: { model?: string; description?: string; prompt: string };
}

/**
 * GET /api/agents/:name/prompt response (D4, AT-2): read-only materialization
 * for clone/preview. Inline prompts pass through verbatim; `{file:…}` refs
 * resolve inside the CONFIG directory only (realpath containment, 64 KiB
 * cap, everything unresolvable fails closed as 404 prompt_unavailable).
 */
export interface AgentPromptResponse {
  name: string;
  source: 'inline' | 'file';
  /** Present only for `source:'file'` — the config-dir-relative ref string. */
  ref?: string;
  prompt: string;
}

// --- agent-pipelines (AP-1..AP-5): definition DTOs + request bodies ----------

/**
 * One role in a pipeline definition (AP-1). `prompt` holds the RESOLVED
 * literal text — template/clone materialized client-side per AT-2/AT-3,
 * never a `{file:}` ref, ≤ 64 KiB (the def is provenance truth; the
 * materialized `agent.<name>` row is runtime truth).
 */
export interface PipelineRoleDef {
  name: string;
  /** Absent ⇒ invoker-model inheritance at delegation (C-R1e) — never invented. */
  model?: string;
  description: string;
  promptSource: 'template' | 'clone' | 'free-text';
  prompt: string;
}

/**
 * Orchestrator INPUT (AC-4'): model + description only — the prompt and
 * `permission.task` are server-generated (AP-3), the row is named by the
 * pipeline key itself.
 */
export interface PipelineOrchestratorDef {
  model?: string;
  description: string;
}

/** One `agent-pipelines[<pipeline>]` value — exact AP-1 shape (strict zod). */
export interface PipelineDefinition {
  roles: PipelineRoleDef[];
  orchestrator: PipelineOrchestratorDef;
  /** Delegated-to names (task-map allows only; never materialized, AP-6). */
  helpers?: string[];
}

/** AC-4' role INPUT: identical shape to the stored def; whitelist-gated. */
export type PipelineRoleInput = PipelineRoleDef;

/** POST/PUT /api/agent-pipelines[/name] body (AC-9'): one atomic batch. */
export interface PipelineSubmitRequest {
  hash: string;
  pipeline: {
    name: string;
    orchestrator: PipelineOrchestratorDef;
    roles: PipelineRoleInput[];
    helpers?: string[];
  };
}

/**
 * GET /api/agent-pipelines response — the definition read surface (builder
 * edit-prefill + view grouping). Raw pass-through of the CONFIG map: reads
 * never validate (shape policing is the WRITE gate's job), so an
 * externally-authored entry mirrors back exactly as stored.
 */
export interface AgentPipelinesResponse {
  pipelines: Record<string, PipelineDefinition>;
}

/** PUT /api/agents/:name/prompt body (SCW-7c; lockstep second op when role). */
export interface UpdatePromptRequest {
  hash: string;
  prompt: string;
}

/** PUT /api/config/default-agent body (AP-7). `agent: null` clears the key. */
export interface SetDefaultAgentRequest {
  hash: string;
  agent: string | null;
}
