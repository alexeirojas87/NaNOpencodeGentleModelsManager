// WU4.3 — save pipeline. Implements SCW-1's strict order; every failing
// stage aborts BEFORE any disk mutation:
//   1. Stale detection (SCW-2): reload CONFIG and compare its SHA-256 plus
//      (when echoed) mtime against the client's load-time snapshot.
//      Mismatch → SaveError 'stale' (409 in WU5): no backup, no write, and
//      the caller's pending ops stay intact for reload-and-reapply.
//   2. Validate (SCW-3/SCW-7): apply the allowlisted patch() ops to the
//      reloaded tree — PatchError propagates pre-backup — then validate();
//      a non-empty issue list → SaveError 'invalid' (400 in WU5) with
//      readable per-path issues and zero disk side effects.
//   3. Backup (SCW-4): the current on-disk bytes go to a timestamped
//      restore point; a failed backup aborts before CONFIG is replaced.
//   4. Atomic replace (SCW-5/SCW-6): JSON.stringify(tree, null, 2) —
//      2-space, insertion order preserved, never sorted, no trailing
//      newline — into a hidden same-directory tmp, fsync, original mode
//      bits, then rename. Readers never observe a truncated CONFIG, and
//      the tmp can never escape the config directory.
//   5. Reload: the post-save bytes/hash/mtime return as the client's new
//      base (the restart notice itself is CX-3 UI territory in WU5/WU6).
import { randomUUID } from 'node:crypto';
import { chmod, open, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { backupConfig, defaultBackupDir } from './backup';
import { load, resolveConfigPath, type LoadedConfig } from './load';
import { patch, type PatchOp } from './patch';
import { validate, type ValidationIssue } from './validate';

/** The snapshot the client's edits are based on (from GET /api/config). */
export interface SaveExpected {
  /** SHA-256 of the bytes at load time — decisive conflict signal (SCW-2). */
  hash: string;
  /** Load-time mtime in epoch ms; compared only when echoed. */
  mtimeMs?: number;
}

export interface SaveOptions {
  /** CONFIG path; defaults to resolveConfigPath() (CONFIG_PATH sandbox). */
  configPath?: string;
  /** Backup dir; defaults to defaultBackupDir(configPath). */
  backupDir?: string;
}

/** Success payload: freshly reloaded state plus this save's restore point. */
export interface SaveResult extends LoadedConfig {
  /** Absolute path of the pre-save backup written for this write (SCW-4). */
  backupPath: string;
}

export type SaveErrorCode = 'stale' | 'invalid';

/**
 * Rejected save, pre-mutation. WU5 maps 'stale' → HTTP 409 and
 * 'invalid' → HTTP 400 (err.issues carry the readable per-path errors).
 */
export class SaveError extends Error {
  readonly code: SaveErrorCode;
  readonly path: string;
  /** 'invalid': readable per-path schema issues; 'stale': empty. */
  readonly issues: ValidationIssue[];
  readonly expectedHash?: string;
  readonly actualHash?: string;

  constructor(
    code: SaveErrorCode,
    configPath: string,
    message: string,
    options: {
      issues?: ValidationIssue[];
      expectedHash?: string;
      actualHash?: string;
      cause?: unknown;
    } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'SaveError';
    this.code = code;
    this.path = configPath;
    this.issues = options.issues ?? [];
    this.expectedHash = options.expectedHash;
    this.actualHash = options.actualHash;
  }
}

function shortHash(hash: string): string {
  return hash.slice(0, 12);
}

/**
 * Apply `ops` to CONFIG through the SCW-1 pipeline. Throws ConfigLoadError
 * (missing/unparseable CONFIG — never created or repaired, PC-1), SaveError
 * 'stale' (SCW-2), PatchError (SCW-7), or SaveError 'invalid' (SCW-3) —
 * always before any mutation. On success the returned hash is the client's
 * new base for the next save.
 */
export async function save(
  ops: readonly PatchOp[],
  expected: SaveExpected,
  options: SaveOptions = {},
): Promise<SaveResult> {
  const configPath = options.configPath ?? resolveConfigPath();

  // 1. Stale detection (SCW-1/SCW-2) — mtime is checked when echoed, but
  // the content hash is what catches fast edits that share a timestamp.
  const current = await load(configPath);
  if (
    current.hash !== expected.hash ||
    (expected.mtimeMs !== undefined && current.mtimeMs !== expected.mtimeMs)
  ) {
    throw new SaveError(
      'stale',
      configPath,
      `CONFIG changed since it was loaded (expected ${shortHash(
        expected.hash,
      )}…, found ${shortHash(
        current.hash,
      )}…) — reload and reapply your edits. Nothing was written.`,
      { expectedHash: expected.hash, actualHash: current.hash },
    );
  }

  // 2. Allowlisted patch + validation before anything can touch the disk
  // (SCW-3 pre-backup gate; SCW-7 enforced by patch() itself).
  const { tree } = patch(current.tree, ops);
  const issues = validate(tree);
  if (issues.length > 0) {
    const first = issues[0];
    throw new SaveError(
      'invalid',
      configPath,
      `${issues.length} validation issue(s) blocked the save — first: ${first.path}: ${first.message}. Nothing was written.`,
      { issues },
    );
  }

  // 3. Backup before mutation (SCW-4); failure here aborts the write.
  const { path: backupPath } = await backupConfig(
    configPath,
    options.backupDir ?? defaultBackupDir(configPath),
  );

  // 4. Atomic same-dir replace (SCW-5/SCW-6).
  const bytes = JSON.stringify(tree, null, 2);
  const tmpPath = join(
    dirname(configPath),
    `.${basename(configPath)}.${randomUUID()}.tmp`,
  );
  try {
    const sourceMode = (await stat(configPath)).mode & 0o777;
    const handle = await open(tmpPath, 'w', 0o600);
    try {
      await handle.writeFile(bytes, 'utf8');
      await handle.sync(); // durable before the rename (design §pipeline)
    } finally {
      await handle.close();
    }
    await chmod(tmpPath, sourceMode); // never widen the original file mode
    await rename(tmpPath, configPath); // same-dir atomic swap
  } catch (err) {
    await unlink(tmpPath).catch(() => {}); // no debris on failure
    throw err;
  }

  // 5. Reload — post-save state is the new stale-detection base.
  const reloaded = await load(configPath);
  return { ...reloaded, backupPath };
}
