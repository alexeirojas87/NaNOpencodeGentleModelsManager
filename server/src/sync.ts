// WU9.2 — gentle-ai sync pass-through (spec OA-3; design §Threat Matrix,
// "Subprocess" row). Runs the gentle-ai sync CLI UNCHANGED with exactly the
// threat response the design prescribes:
//   • execFile with an argv array and shell:false — shell metacharacters can
//     never be interpreted, only arrive as literal argv (threat #1);
//   • per-flag argv allowlist (--profile / --profile-phase /
//     --sdd-profile-strategy) with value patterns; anything else is rejected
//     before the child is spawned (threat #2). The design words the pattern
//     as "name:provider/model"; task 9.4's pinned `gentle-ai sync --help`
//     shows each flag's real shape, so the map below enforces exactly those
//     three documented formats — all limited to the [\\w.:/-] charset, which
//     is what closes the injection door (no shell char can appear at all);
//   • a 60s timeout, surfaced as a typed error instead of a hang (threat #3);
//   • a 1MB combined stdout/stderr cap; floods kill the child with a typed
//     error (threat #4).
// The binary is FIXED to gentle-ai from the client's point of view — request
// bodies can never choose an executable. GENTLE_AI_BIN is the same sandbox
// override convention as CONFIG_PATH/AUTH_PATH: it lets tests stub the
// binary and lets operators pin an explicit path; it is never client input.
// stdin is closed ('ignore') so a sync that tried to prompt gets EOF
// immediately rather than deadlocking the request (OPEN-Q#1: sync verified
// non-interactive in task 9.4).
import {
  execFile,
  type ExecFileOptionsWithStringEncoding,
} from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Threat-matrix deadline: a hung sync is killed and surfaced, never left running. */
export const SYNC_TIMEOUT_MS = 60_000;
/** Threat-matrix flood guard: maxBuffer caps captured stdout+stderr at 1MB. */
export const SYNC_OUTPUT_CAP_BYTES = 1024 * 1024;
/** Sandbox/test override for the executable — server config, never request input. */
export const SYNC_BINARY_ENV = 'GENTLE_AI_BIN';

/**
 * The argv allowlist (design §Threat Matrix), one value pattern per flag,
 * pinned to the shapes the CLI documents (`gentle-ai sync --help`):
 *   --profile             <name:provider/model>
 *   --profile-phase       <name:phase:model[/...]>
 *   --sdd-profile-strategy <strategy>
 * Every charset is [\w.:/-] plus structural separators only — no space, no
 * quote, no shell metacharacter can survive validation.
 */
export const SYNC_ARG_ALLOWLIST: Readonly<Record<string, RegExp>> = {
  '--profile': /^[\w.-]+:[\w.-]+\/[\w.-]+$/,
  '--profile-phase': /^[\w.-]+:[\w.-]+:[\w.-]+(?:\/[\w.-]+)?$/,
  '--sdd-profile-strategy': /^[\w.-]+$/,
};

export type SyncErrorCode =
  | 'sync_bad_args'
  | 'sync_timeout'
  | 'sync_output_limit'
  | 'sync_spawn'
  | 'sync_failed';

/** Typed sync failure; routes/http.ts maps each code to the error envelope. */
export class SyncError extends Error {
  readonly code: SyncErrorCode;
  /** Index of the offending token in the requested args (for sync_bad_args). */
  readonly argIndex?: number;
  /** Length-bounded echo of the rejected token — diagnostic, never trusted. */
  readonly arg?: string;

  constructor(
    code: SyncErrorCode,
    message: string,
    extras: { argIndex?: number; arg?: string } = {},
  ) {
    super(message);
    this.name = 'SyncError';
    this.code = code;
    this.argIndex = extras.argIndex;
    this.arg = extras.arg;
  }
}

/** Echo of at most 80 chars of user-supplied text in an error message. */
function echo(token: unknown): string {
  const s = typeof token === 'string' ? token : String(token);
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

/** Fixed binary 'gentle-ai'; GENTLE_AI_BIN overrides (tests/sandbox only). */
export function resolveSyncBinary(
  env: Record<string, string | undefined> = process.env,
): string {
  const fromEnv = env[SYNC_BINARY_ENV]?.trim();
  return fromEnv ? fromEnv : 'gentle-ai';
}

/**
 * Validate request-supplied args against the flag allowlist. Absent/null →
 * a bare pass-through sync (`gentle-ai sync`, no args). Every rejection is
 * a SyncError 'sync_bad_args' carrying the offending index — the child is
 * NEVER spawned for a rejected batch.
 */
export function validateSyncArgs(args: unknown): string[] {
  if (args === undefined || args === null) return [];
  if (!Array.isArray(args)) {
    throw new SyncError(
      'sync_bad_args',
      '"args" must be an array of sync flag strings.',
    );
  }
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token: unknown = args[i];
    if (typeof token !== 'string') {
      throw new SyncError(
        'sync_bad_args',
        `Argument at index ${i} must be a string.`,
        { argIndex: i, arg: echo(token) },
      );
    }
    const eq = token.indexOf('=');
    const flag = eq === -1 ? token : token.slice(0, eq);
    if (!flag.startsWith('--') || !Object.hasOwn(SYNC_ARG_ALLOWLIST, flag)) {
      throw new SyncError(
        'sync_bad_args',
        `Argument at index ${i} is not an allowlisted sync flag. Allowed: ${Object.keys(SYNC_ARG_ALLOWLIST).join(', ')}.`,
        { argIndex: i, arg: echo(token) },
      );
    }
    const pattern = SYNC_ARG_ALLOWLIST[flag];
    if (eq !== -1) {
      // Inline --flag=value form: same value rule, token forwarded verbatim.
      const value = token.slice(eq + 1);
      if (value.startsWith('--') || !pattern.test(value)) {
        throw new SyncError(
          'sync_bad_args',
          `Value for ${flag} must match ${expectedShape(flag)} (index ${i}).`,
          { argIndex: i, arg: echo(token) },
        );
      }
      out.push(token);
      continue;
    }
    // Spaced --flag value form: the NEXT token is the value — a second flag
    // there is a shape violation, never a value.
    const value = args[i + 1];
    if (
      typeof value !== 'string' ||
      value.startsWith('--') ||
      !pattern.test(value)
    ) {
      throw new SyncError(
        'sync_bad_args',
        `Value for ${flag} must match ${expectedShape(flag)} (index ${i + 1}).`,
        { argIndex: i + 1, arg: echo(value ?? '(missing)') },
      );
    }
    out.push(token, value);
    i += 1; // value consumed as the flag's argument
  }
  return out;
}

/** Human-readable value-shape hint for rejection messages. */
function expectedShape(flag: string): string {
  switch (flag) {
    case '--profile':
      return 'the name:provider/model pattern';
    case '--profile-phase':
      return 'the name:phase:model pattern';
    default:
      return 'a single safe token (word chars, dot, dash)';
  }
}

export interface SyncOptions {
  /** Executable override (tests stub the binary); default resolveSyncBinary(). */
  binary?: string;
  timeoutMs?: number;
  outputCapBytes?: number;
  /** Child environment — defaults to this process's env (pass-through). */
  env?: NodeJS.ProcessEnv;
}

export interface SyncResult {
  /** Process exit code — a non-zero value is an OUTCOME, not a thrown error. */
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the command once: `gentle-ai sync [args…]`, unchanged. The `sync`
 * subcommand is FIXED here — part of the endpoint's identity, never
 * client-supplied or removable (that exact omission is what task 9.4's live
 * pass caught in the first draft: a bare `gentle-ai` opens the TUI).
 * Resolves for exit 0 AND for non-zero exits (OA-3: the failure code must
 * surface); rejects only when the boundary itself failed — rejected args
 * are handled earlier, and timeout/flood/spawn problems arrive as typed
 * SyncErrors.
 */
export async function runSync(
  args: readonly string[],
  options: SyncOptions = {},
): Promise<SyncResult> {
  const binary = options.binary ?? resolveSyncBinary();
  const timeoutMs = options.timeoutMs ?? SYNC_TIMEOUT_MS;
  const maxBuffer = options.outputCapBytes ?? SYNC_OUTPUT_CAP_BYTES;
  // execFile forwards `stdio` to spawn at runtime, but @types/node's
  // ExecFileOptions omits the key; the typed const keeps the closed-stdin
  // hardening ('ignore' → child reads EOF instantly instead of blocking on
  // a hypothetical prompt until the timeout — task 9.4 evidence shows the
  // gentle-ai root TUI gate really does refuse non-TTY launches) without
  // an untyped cast. encoding is explicit so the promise types as strings.
  const execOpts: ExecFileOptionsWithStringEncoding & {
    stdio: ['ignore', 'pipe', 'pipe'];
  } = {
    encoding: 'utf8',
    shell: false, // threat #1: argv only, no shell string is ever built
    timeout: timeoutMs, // threat #3: hung syncs are killed at the deadline
    maxBuffer, // threat #4: floods abort with a typed error, not unbounded memory
    stdio: ['ignore', 'pipe', 'pipe'],
    env: options.env ?? process.env,
  };
  try {
    const { stdout, stderr } = await execFileAsync(
      binary,
      ['sync', ...args],
      execOpts,
    );
    return { exitCode: 0, stdout, stderr };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      killed?: boolean;
      signal?: NodeJS.Signals | null;
      stdout?: string;
      stderr?: string;
    };
    // Order matters: the flood guard kills the child too, so check it first.
    // Node ≥ 22 rejects with ERR_CHILD_PROCESS_STDIO_MAXBUFFER; ENOBUFS is
    // the historical code — both mean "output cap exceeded, child killed".
    if (
      e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ||
      e.code === 'ENOBUFS'
    ) {
      throw new SyncError(
        'sync_output_limit',
        `gentle-ai sync exceeded the ${maxBuffer}-byte output cap and was killed.`,
      );
    }
    if (e.killed === true) {
      throw new SyncError(
        'sync_timeout',
        `gentle-ai sync timed out after ${timeoutMs} ms and was killed (${e.signal ?? 'SIGTERM'}).`,
      );
    }
    if (typeof e.code === 'number') {
      // The child ran and exited non-zero: pass the outcome through (threat
      // matrix #4 "nonzero exit passed, no success state").
      return {
        exitCode: e.code,
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? '',
      };
    }
    if (e.code === 'ENOENT') {
      throw new SyncError(
        'sync_spawn',
        `gentle-ai executable not found ("${binary}"). Is gentle-ai installed and on the server's PATH?`,
      );
    }
    throw new SyncError(
      'sync_failed',
      `gentle-ai sync could not be run: ${e.message}`,
    );
  }
}
