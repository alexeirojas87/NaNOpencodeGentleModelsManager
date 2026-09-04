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
 * GET /api/status response envelope (design §API-Surface).
 * `drift` and `snapshotAsOf` stay empty/null until the bundled NaN snapshot
 * ships in WU7; `backups` lists restore points newest-first (SCW-4).
 */
export interface StatusResponse {
  /** Resolved CONFIG path (sandbox-aware via CONFIG_PATH). */
  path: string;
  /** Current content hash — same staleness signal as GET /api/config. */
  hash: string;
  /** CONFIG mtime in epoch milliseconds. */
  mtime: number;
  /** Declared-vs-snapshot drift cells (WU7). */
  drift: unknown[];
  snapshotAsOf: string | null;
  /** Backup file paths, newest first. */
  backups: string[];
  /** True once this server process has written CONFIG (CX-3 carrier). */
  restartRequired: boolean;
}
