// WU2.2 — CONFIG load core (PC-1, SCW-1 inputs).
// Reads CONFIG (explicit path > CONFIG_PATH env > ~/.config/opencode/
// opencode.json) and returns everything the save pipeline needs to detect
// staleness: raw bytes, parsed insertion-ordered tree, SHA-256 content hash
// and mtime. A missing or unparseable CONFIG is an ERROR — this module never
// creates, repairs or normalizes the file (spec PC-1 hard constraint).
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * In-memory CONFIG as a plain JSON object tree. Keys keep JSON.parse
 * insertion order; serialization back to disk is JSON.stringify(tree, null, 2)
 * and must never sort keys (SCW-6). Refined in WU3.2 (shared/types.ts).
 */
export interface ConfigTree {
  [key: string]: unknown;
}

/** Result of a successful load — inputs for stale detection (SCW-1/SCW-2). */
export interface LoadedConfig {
  /** Resolved path the file was read from. */
  path: string;
  /** Exact bytes on disk at read time. */
  raw: string;
  /** Parsed tree in insertion order. */
  tree: ConfigTree;
  /** SHA-256 hex of `raw` — echoed by writes, mismatch ⇒ 409 (SCW-2). */
  hash: string;
  /** File modification time (truncated to whole ms, matches mtimeMs). */
  mtime: Date;
  /** mtime in epoch milliseconds. */
  mtimeMs: number;
}

export type ConfigLoadErrorCode = 'missing' | 'parse' | 'io';

/** Failure to load CONFIG. Carries the path; message is user-displayable. */
export class ConfigLoadError extends Error {
  readonly code: ConfigLoadErrorCode;
  readonly path: string;

  constructor(
    code: ConfigLoadErrorCode,
    configPath: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ConfigLoadError';
    this.code = code;
    this.path = configPath;
  }
}

/** Default CONFIG location per OpenCode convention (never created). */
export function defaultConfigPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(env.HOME || homedir(), '.config', 'opencode', 'opencode.json');
}

/**
 * Resolve the CONFIG path. CONFIG_PATH is the sandbox/test override (task
 * 1.3 rule: fs-touching tests point it at a temp-dir fixture copy).
 * Pure — does not touch the filesystem.
 */
export function resolveConfigPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const fromEnv = env.CONFIG_PATH?.trim();
  return fromEnv ? fromEnv : defaultConfigPath(env);
}

/**
 * Load CONFIG from `configPath` (defaults to resolveConfigPath()).
 * Rejects with ConfigLoadError on missing ('missing'), invalid JSON or
 * non-object top level ('parse'), or any other fs failure ('io').
 * Read-only by contract: no file is ever created or repaired.
 */
export async function load(
  configPath: string = resolveConfigPath(),
): Promise<LoadedConfig> {
  let raw: string;
  let mtimeMs: number;
  try {
    const [bytes, stats] = await Promise.all([
      readFile(configPath, 'utf8'),
      stat(configPath),
    ]);
    raw = bytes;
    mtimeMs = Math.trunc(stats.mtimeMs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConfigLoadError(
        'missing',
        configPath,
        `CONFIG not found at ${configPath}. The dashboard will not create or repair it.`,
        { cause: err },
      );
    }
    throw new ConfigLoadError(
      'io',
      configPath,
      `CONFIG could not be read from ${configPath}: ${(err as Error).message}`,
      { cause: err },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigLoadError(
      'parse',
      configPath,
      `CONFIG at ${configPath} is not valid JSON — nothing was modified.`,
      { cause: err },
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigLoadError(
      'parse',
      configPath,
      `CONFIG at ${configPath} must be a JSON object at the top level — nothing was modified.`,
    );
  }

  return {
    path: configPath,
    raw,
    tree: parsed as ConfigTree,
    hash: createHash('sha256').update(raw, 'utf8').digest('hex'),
    mtime: new Date(mtimeMs),
    mtimeMs,
  };
}
