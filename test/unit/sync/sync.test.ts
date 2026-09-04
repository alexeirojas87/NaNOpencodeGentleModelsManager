// WU9.1 (RED) — the four threat-matrix subprocess tests (design §Threat
// Matrix, "Subprocess (gentle-ai sync)" row), run against the sync core with
// a STUB binary so no real gentle-ai is ever invoked here:
//   #1 shell metachars arrive as literal argv — execFile with shell:false,
//      never a shell string; a token full of ; $() `` and spaces reaches the
//      child as ONE argv element and never interprets;
//   #2 unknown args rejected before any spawn (allowlist
//      --profile/--profile-phase/--sdd-profile-strategy with per-flag value
//      patterns — the design's "value pattern name:provider/model", pinned
//      to the CLI's own --help shapes in task 9.4);
//   #3 60s timeout surfaced as a typed error, never a hang;
//   #4 non-zero exit passed through as an outcome, not thrown, and the 1MB
//      output cap kills floods.
// Sandbox rule: the stub lives in an mkdtemp dir; nothing here touches
// ~/.config/opencode or the installed gentle-ai binary.
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  SYNC_OUTPUT_CAP_BYTES,
  SYNC_TIMEOUT_MS,
  SyncError,
  resolveSyncBinary,
  runSync,
  validateSyncArgs,
} from '../../../server/src/sync';

interface StubCase {
  /** File receiving JSON {argv: [...]} of what the stub was invoked with. */
  dump?: string;
  stdout?: string;
  stderr?: string;
  /** Write this many bytes to stdout (flood scenario for the cap). */
  floodBytes?: number;
  /** Rewrite CONFIG with {path, content} before exiting (simulated sync write). */
  rewriteConfig?: { path: string; content: string };
  /** Never exit: keeps the event loop alive so the timeout must fire. */
  sleep?: boolean;
  exit?: number;
}

let sandbox: string;
let caseId = 0;

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'mdash-sync-unit-'));
});
afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/**
 * Write an executable Node stub (the "fake gentle-ai") whose behavior is
 * baked into the file: dumps argv, writes the configured output, optionally
 * rewrites CONFIG, then exits with the configured code (or hangs).
 * Plain CJS with a shebang — tmpdir has no package.json, so require() works.
 */
function stub(caseCfg: StubCase): string {
  const path = join(sandbox, `sync-stub-${caseId++}.cjs`);
  const src = `#!/usr/bin/env node
// Sync stub binary (WU9 RED) — records argv, replays a canned scenario.
// All output goes through fs.writeSync: a plain process.stdout.write that
// exceeds the pipe buffer would be dropped by process.exit(), making the
// flood/cap scenarios non-deterministic.
const fs = require('node:fs');
const CASE = ${JSON.stringify(caseCfg)};
if (CASE.dump) fs.writeFileSync(CASE.dump, JSON.stringify({ argv: process.argv.slice(2) }));
if (CASE.stdout) fs.writeSync(1, CASE.stdout);
if (CASE.floodBytes) fs.writeSync(1, 'x'.repeat(CASE.floodBytes) + '\\n');
if (CASE.stderr) fs.writeSync(2, CASE.stderr);
if (CASE.rewriteConfig) fs.writeFileSync(CASE.rewriteConfig.path, CASE.rewriteConfig.content);
if (CASE.sleep) { setInterval(() => {}, 1000); } else { process.exit(CASE.exit ?? 0); }
`;
  writeFileSync(path, src, 'utf8');
  chmodSync(path, 0o755);
  return path;
}

const dumpArgv = (dump: string): string[] =>
  (JSON.parse(readFileSync(dump, 'utf8')) as { argv: string[] }).argv;

describe('sync — threat #1: metachars arrive as literal argv (execFile, shell:false)', () => {
  it('a token full of shell metacharacters reaches the child as ONE literal argv element', async () => {
    const dump = join(sandbox, 'argv-metachar.json');
    const marker = join(sandbox, 'PWNED');
    // Everything a naive `exec(cmd)` would interpret: command separator,
    // command substitution, backticks, glob, redirect.
    const evil = `sdd-spec:nan/qwen3.8-flash;touch ${marker} $(echo pwned) \`id\` >${marker} *`;
    const result = await runSync([evil], { binary: stub({ dump, exit: 0 }) });

    expect(result.exitCode).toBe(0);
    // The stub received the literal token byte-for-byte after the fixed
    // 'sync' subcommand, and nothing was ever interpreted.
    expect(dumpArgv(dump)).toEqual(['sync', evil]);
    expect(existsSync(marker)).toBe(false);
  });
});

describe('sync — threat #2: allowlisted args, everything else rejected pre-spawn', () => {
  it('unknown flags and bare positionals are rejected (sync_bad_args, no spawn)', () => {
    for (const bad of [
      ['--dry-run'], // real gentle-ai flag but NOT on the allowlist
      ['--profile', 'x:nan/m', '--nope'],
      ['positional'],
      ['--profile=unknown-shape'], // inline form still must match the pattern
      [42],
    ]) {
      let thrown: unknown;
      try {
        validateSyncArgs(bad);
      } catch (err) {
        thrown = err;
      }
      expect(
        thrown,
        `expected rejection for ${JSON.stringify(bad)}`,
      ).toBeInstanceOf(SyncError);
      expect((thrown as SyncError).code).toBe('sync_bad_args');
      expect(typeof (thrown as SyncError).argIndex).toBe('number');
    }
  });

  it('values must match their flag pattern: name:provider/model shapes only', () => {
    // --profile value with metachar or wrong arity → rejected at the VALUE index.
    const rejects: [string, string][] = [
      ['--profile', 'x:nan/m;rm -rf /'],
      ['--profile', 'no-colon-here'],
      ['--profile', 'a:b/c/d'],
      ['--profile', ''],
      ['--profile-phase', 'only:two'],
      ['--sdd-profile-strategy', 'two words'],
      ['--sdd-profile-strategy', 'a/b'],
    ];
    for (const [flag, value] of rejects) {
      expect(() => validateSyncArgs([flag, value])).toThrow(SyncError);
    }
    // A flag in the value slot never masquerades as a value.
    expect(() =>
      validateSyncArgs(['--sdd-profile-strategy', '--profile']),
    ).toThrow(SyncError);
    // Dangling flag: missing value is an error, not a half-spawn.
    expect(() => validateSyncArgs(['--profile'])).toThrow(SyncError);
  });

  it('allowlisted shapes pass verbatim (incl. the inline --flag=value form)', () => {
    expect(validateSyncArgs([])).toEqual([]);
    expect(validateSyncArgs(undefined)).toEqual([]);
    expect(
      validateSyncArgs(['--profile', 'sdd-spec:nan/qwen3.8-flash']),
    ).toEqual(['--profile', 'sdd-spec:nan/qwen3.8-flash']);
    expect(
      validateSyncArgs([
        '--profile=sdd-spec:nan/qwen3.8-flash',
        '--sdd-profile-strategy',
        'external-single-active',
      ]),
    ).toEqual([
      '--profile=sdd-spec:nan/qwen3.8-flash',
      '--sdd-profile-strategy',
      'external-single-active',
    ]);
    // --profile-phase takes name:phase:model per the CLI help (task 9.4 pins
    // these shapes); both a bare model and a provider/model tail are allowed.
    expect(
      validateSyncArgs(['--profile-phase', 'sdd-spec:apply:nan/qwen3.8-flash']),
    ).toEqual(['--profile-phase', 'sdd-spec:apply:nan/qwen3.8-flash']);
    expect(
      validateSyncArgs(['--profile-phase', 'sdd-spec:apply:qwen3.8-flash']),
    ).toEqual(['--profile-phase', 'sdd-spec:apply:qwen3.8-flash']);
  });

  it('validated args reach the stub binary as an exact literal argv array', async () => {
    const dump = join(sandbox, 'argv-allowlisted.json');
    const argv = validateSyncArgs(['--profile', 'sdd-spec:nan/qwen3.8-flash']);
    const result = await runSync(argv, { binary: stub({ dump, exit: 0 }) });
    expect(result.exitCode).toBe(0);
    expect(dumpArgv(dump)).toEqual([
      'sync',
      '--profile',
      'sdd-spec:nan/qwen3.8-flash',
    ]);
  });
});

describe('sync — threat #3: the 60s timeout surfaces as an error, never a hang', () => {
  it('the wired default is 60_000 ms', () => {
    expect(SYNC_TIMEOUT_MS).toBe(60_000);
  });

  it('a child that never exits is killed at the deadline with a typed sync_timeout', async () => {
    const started = Date.now();
    let thrown: unknown;
    try {
      // Small injected deadline so the suite stays fast; the mechanism and
      // the default constant above are both pinned.
      await runSync([], { binary: stub({ sleep: true }), timeoutMs: 400 });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SyncError);
    expect((thrown as SyncError).code).toBe('sync_timeout');
    expect((thrown as SyncError).message).toMatch(/timed out/);
    // Returned promptly at the deadline — not left hanging.
    expect(Date.now() - started).toBeLessThan(15_000);
  });
});

describe('sync — threat #4: exit code passes through; the 1MB cap kills floods', () => {
  it('a non-zero exit resolves as an outcome with stdout/stderr, not a rejection', async () => {
    const dump = join(sandbox, 'argv-fail.json');
    const result = await runSync(['--profile', 'x:nan/m'], {
      binary: stub({
        dump,
        stdout: 'partial work before failing\n',
        stderr: 'gentle-ai sync: profile not found\n',
        exit: 7,
      }),
    });
    expect(result).toEqual({
      exitCode: 7,
      stdout: 'partial work before failing\n',
      stderr: 'gentle-ai sync: profile not found\n',
    });
    expect(dumpArgv(dump)).toEqual(['sync', '--profile', 'x:nan/m']);
  });

  it('the output cap is 1MB; floods are killed with a typed error, normal output survives', async () => {
    expect(SYNC_OUTPUT_CAP_BYTES).toBe(1024 * 1024);

    let thrown: unknown;
    try {
      await runSync([], { binary: stub({ floodBytes: 1_200_000 }) });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SyncError);
    expect((thrown as SyncError).code).toBe('sync_output_limit');

    const big = 'y'.repeat(200_000) + '\n';
    const ok = await runSync([], { binary: stub({ stdout: big }) });
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout.length).toBe(big.length);
  });
});

describe('sync — binary resolution (design: fixed binary, env-override for stubs/sandbox)', () => {
  it('defaults to gentle-ai; GENTLE_AI_BIN overrides for tests and sandboxing', () => {
    expect(resolveSyncBinary({})).toBe('gentle-ai');
    expect(
      resolveSyncBinary({ GENTLE_AI_BIN: '/opt/homebrew/bin/gentle-ai' }),
    ).toBe('/opt/homebrew/bin/gentle-ai');
    expect(resolveSyncBinary({ GENTLE_AI_BIN: '   ' })).toBe('gentle-ai');
  });

  it('a missing executable surfaces as sync_spawn, not an unhandled crash', async () => {
    let thrown: unknown;
    try {
      await runSync([], { binary: join(sandbox, 'definitely-not-here') });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SyncError);
    expect((thrown as SyncError).code).toBe('sync_spawn');
  });
});
