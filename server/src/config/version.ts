// phase-agents-v3 — gentle-ai version resolution (design Decision 4, spec
// area version-detection). Chain: read `~/.gentle-ai/state.json` key
// `installed_binary_version` → on any state-stage gap, spawn
// `<binary> --version` → on any spawn failure, degrade conservatively to
// `unknown` (≡ 2.x ownership semantics) with a typed detail — this module
// NEVER throws to callers and never crashes the status route (spec: degrade
// conservatively, no crash).
//
// The spawn follows the sync.ts threat-matrix precedent exactly: execFile
// with an argv array and shell:false (no shell string is ever built), a
// timeout surfaced as a typed error, a 1MB maxBuffer flood guard, and stdin
// closed ('ignore'). The binary is FIXED server-side — GENTLE_AI_BIN is the
// same sandbox override convention as CONFIG_PATH/AUTH_PATH (load.ts) and is
// never client input; GENTLE_AI_STATE_PATH is the new sandbox override this
// module contributes for hermetic tests.
import {
  execFile,
  type ExecFileOptionsWithStringEncoding,
} from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type VersionMode = '3.x' | '2.x' | 'unknown';
export type VersionSource =
  'state_file' | 'binary_probe' | 'conservative_fallback';
export type VersionErrorCode =
  | 'state_unreadable'
  | 'spawn_not_found'
  | 'spawn_timeout'
  | 'spawn_output_limit'
  | 'spawn_failed'
  | 'unparseable';

/** Typed resolution failure; consumed as conservative-fallback detail text. */
export class VersionError extends Error {
  readonly code: VersionErrorCode;

  constructor(code: VersionErrorCode, message: string) {
    super(message);
    this.name = 'VersionError';
    this.code = code;
  }
}

/** Resolution outcome: null version ⇔ mode 'unknown' (conservative). */
export interface GentleAiVersion {
  version: string | null;
  mode: VersionMode;
  source: VersionSource;
  /** Present ONLY on conservative_fallback — typed error text (D3 contract). */
  detail?: string;
}

/** Threat-matrix deadline: a hung --version probe is killed, never awaited. */
export const VERSION_TIMEOUT_MS = 10_000;
/** Threat-matrix flood guard: maxBuffer caps captured stdout at 1MB. */
export const VERSION_OUTPUT_CAP_BYTES = 1024 * 1024;
/** Sandbox/test override for the state file — server config, never request input. */
export const VERSION_STATE_ENV = 'GENTLE_AI_STATE_PATH';
/** Sandbox/test override for the binary (sync.ts convention) — never request input. */
export const VERSION_BINARY_ENV = 'GENTLE_AI_BIN';

/** Default gentle-ai state location per gentle-ai convention (never created). */
export function defaultStatePath(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(env.HOME || homedir(), '.gentle-ai', 'state.json');
}

/** Resolve the state path: GENTLE_AI_STATE_PATH override > default. Pure. */
export function resolveStatePath(
  env: Record<string, string | undefined> = process.env,
): string {
  const fromEnv = env[VERSION_STATE_ENV]?.trim();
  return fromEnv ? fromEnv : defaultStatePath(env);
}

/** Resolve the probe binary: GENTLE_AI_BIN override > 'gentle-ai'. Pure. */
export function resolveBinary(
  env: Record<string, string | undefined> = process.env,
): string {
  return env[VERSION_BINARY_ENV]?.trim() || 'gentle-ai';
}

/**
 * Injectable spawn boundary (unit tests pass a spy/fake directly —
 * hermetic). Shaped after promisified execFile with a UTF-8 result.
 */
export type SpawnFn = (
  binary: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

const defaultSpawn: SpawnFn = (binary, args, options) => {
  // execFile forwards `stdio` to spawn at runtime, but @types/node's
  // ExecFileOptions omits the key — the typed const (sync.ts:207 precedent)
  // keeps the closed-stdin hardening without an untyped cast; encoding is
  // explicit so the promise types as strings.
  const execOpts: ExecFileOptionsWithStringEncoding & {
    stdio: ['ignore', 'pipe', 'pipe'];
  } = {
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  };
  return execFileAsync(binary, [...args], execOpts);
};

/** First `X.Y.Z` occurrence in a version string (state key or probe stdout). */
const VERSION_RE = /(\d+\.\d+\.\d+)/;

/**
 * Mode mapping (design Decision 4): major ≥3 → '3.x'; major 1/2 → '2.x';
 * anything unresolved (including 0 or garbage) → 'unknown'. Ownership
 * treats 'unknown' ≡ '2.x'.
 */
function modeOf(version: string | null): VersionMode {
  if (version === null) return 'unknown';
  const major = Number.parseInt(VERSION_RE.exec(version)?.[1] ?? '', 10);
  if (!Number.isFinite(major)) return 'unknown';
  if (major >= 3) return '3.x';
  if (major === 1 || major === 2) return '2.x';
  return 'unknown';
}

/** Map a Node execFile-shaped error onto a typed VersionError. */
function spawnError(err: unknown): VersionError {
  const e = err as { code?: unknown; killed?: boolean; signal?: unknown };
  const message = err instanceof Error ? err.message : String(err);
  // maxBuffer flood: modern Node uses ERR_CHILD_PROCESS_STDIO_MAXBUFFER;
  // older releases used ENOBUFS. Both kill the child — map to one code.
  if (
    e?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ||
    e?.code === 'ENOBUFS'
  ) {
    return new VersionError(
      'spawn_output_limit',
      `gentle-ai --version output exceeded the ${VERSION_OUTPUT_CAP_BYTES}-byte cap: ${message}`,
    );
  }
  if (e?.code === 'ENOENT') {
    return new VersionError(
      'spawn_not_found',
      `gentle-ai binary not found: ${message}`,
    );
  }
  if (e?.killed === true) {
    return new VersionError(
      'spawn_timeout',
      `gentle-ai --version timed out after ${VERSION_TIMEOUT_MS}ms (signal ${String(e?.signal)})`,
    );
  }
  return new VersionError(
    'spawn_failed',
    `gentle-ai --version failed: ${message}`,
  );
}

/**
 * Injectable core — reads the state file at `statePath`, falls back to
 * probing `binary`, and degrades conservatively on ANY failure. Never
 * throws: every failure path resolves to a conservative_fallback result
 * whose `detail` names the typed code(s) encountered along the chain.
 */
export async function resolveVersionWith(opts: {
  statePath: string;
  binary: string;
  spawn?: SpawnFn;
}): Promise<GentleAiVersion> {
  const spawn = opts.spawn ?? defaultSpawn;
  // --- stage 1: state file -------------------------------------------------
  // Absent file is the NORMAL fresh-machine shape (no state note). A present
  // but unreadable/corrupt file is a state_unreadable fact — recorded and
  // carried into the detail if the chain ends conservatively.
  let stateNote: VersionError | null = null;
  let raw: string | null = null;
  try {
    raw = await readFile(opts.statePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      stateNote = new VersionError(
        'state_unreadable',
        `state file at ${opts.statePath} could not be read: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed)
      ) {
        const declared = (parsed as Record<string, unknown>)[
          'installed_binary_version'
        ];
        if (typeof declared === 'string' && declared.trim().length > 0) {
          const version = declared.trim();
          return {
            version,
            mode: modeOf(version),
            source: 'state_file',
          };
        }
      }
    } catch {
      stateNote = new VersionError(
        'state_unreadable',
        `state file at ${opts.statePath} is not valid JSON`,
      );
    }
  }
  // --- stage 2: binary probe ----------------------------------------------
  try {
    const { stdout } = await spawn(opts.binary, ['--version'], {
      timeout: VERSION_TIMEOUT_MS,
      maxBuffer: VERSION_OUTPUT_CAP_BYTES,
    });
    const found = VERSION_RE.exec(stdout)?.[1];
    if (found === undefined) {
      throw new VersionError(
        'unparseable',
        `gentle-ai --version printed unparseable output: ${JSON.stringify(
          stdout.slice(0, 200),
        )}`,
      );
    }
    return { version: found, mode: modeOf(found), source: 'binary_probe' };
  } catch (err) {
    const spawnNote = err instanceof VersionError ? err : spawnError(err); // rejections that are not VersionError-shaped
    const detail = [
      stateNote === null ? null : `[${stateNote.code}] ${stateNote.message}`,
      `[${spawnNote.code}] ${spawnNote.message}`,
    ]
      .filter((part): part is string => part !== null)
      .join('; ');
    return {
      version: null,
      mode: 'unknown',
      source: 'conservative_fallback',
      detail,
    };
  }
}

/**
 * Env-driven entry point (status route + gates): resolves the
 * (statePath, binary) pair from the environment and memoizes the result per
 * pair. The production pair is cached for PROCESS LIFETIME (spec: the spawn
 * fallback runs exactly once), while a changed env pair (sandbox tests)
 * resolves fresh without reset hacks. The promise itself is cached so
 * concurrent callers share one resolution.
 */
const memo = new Map<string, Promise<GentleAiVersion>>();

export async function resolveVersion(): Promise<GentleAiVersion> {
  const statePath = resolveStatePath();
  const binary = resolveBinary();
  const key = `${statePath}\u0000${binary}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const pending = resolveVersionWith({ statePath, binary });
  memo.set(key, pending);
  return pending;
}
