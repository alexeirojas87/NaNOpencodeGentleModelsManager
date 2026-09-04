// WU4.3 — backup writer (SCW-4: every successful save leaves an exact-byte
// pre-save restore point). Backups are dashboard-owned and live beside the
// CONFIG file in <config dir>/model-dashboard-backups/opencode-<ISO>.json
// (design §Config-Editing-Core). The sibling location means CONFIG_PATH
// sandboxing relocates backups too — automated tests never write ~/.config.
// The newest KEEP_BACKUPS are kept; pruning deletes only opencode-*.json
// names, never foreign files. Bytes and mode bits are preserved verbatim:
// an apiKey-bearing config that is 0600 on disk must not back up as 0644.
import { constants } from 'node:fs';
import { chmod, copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Dashboard-owned backup directory name (design §Config-Editing-Core). */
export const BACKUP_DIR_NAME = 'model-dashboard-backups';

/** How many newest backups each save keeps before pruning (SCW-4). */
export const KEEP_BACKUPS = 20;

/** The only files pruning may ever touch inside the backup dir. */
const BACKUP_FILE = /^opencode-.*\.json$/;

export interface BackupResult {
  /** Absolute path of the backup just written. */
  path: string;
  /** How many older backups pruning removed to enforce KEEP_BACKUPS. */
  pruned: number;
}

/** Default backup dir: sibling of the CONFIG file. Pure — no fs access. */
export function defaultBackupDir(configPath: string): string {
  return join(dirname(configPath), BACKUP_DIR_NAME);
}

// Monotonic ms clock for the ISO name: back-to-back saves inside the same
// millisecond still get distinct names, and the names keep sorting in
// creation order (what "restore the newest" and pruning rely on).
let lastStampMs = 0;
function nextBackupName(): string {
  lastStampMs = Math.max(Date.now(), lastStampMs + 1);
  return `opencode-${new Date(lastStampMs).toISOString()}.json`;
}

/**
 * Copy the current on-disk bytes of CONFIG to a timestamped backup.
 * Throws if the copy fails — callers must treat that as "abort the save
 * before mutating CONFIG" (SCW-1: a failing stage aborts all mutation).
 */
export async function backupConfig(
  configPath: string,
  backupDir: string = defaultBackupDir(configPath),
): Promise<BackupResult> {
  await mkdir(backupDir, { recursive: true });
  const sourceMode = (await stat(configPath)).mode & 0o777;
  const backupPath = join(backupDir, nextBackupName());
  // EXCL: a restore point is never silently overwritten — a name clash
  // fails loudly instead of losing the older copy.
  await copyFile(configPath, backupPath, constants.COPYFILE_EXCL);
  // copyFile mode semantics vary by platform — set the source mode
  // explicitly so preservation is guaranteed, not best effort (SCW-4).
  await chmod(backupPath, sourceMode);
  const pruned = await pruneBackups(backupDir);
  return { path: backupPath, pruned };
}

/** Drop the oldest entries until only the newest KEEP_BACKUPS remain. */
async function pruneBackups(backupDir: string): Promise<number> {
  const names = (await readdir(backupDir))
    .filter((name) => BACKUP_FILE.test(name))
    .sort(); // ISO names sort chronologically
  const excess = names.slice(0, Math.max(0, names.length - KEEP_BACKUPS));
  for (const name of excess) {
    await rm(join(backupDir, name));
  }
  return excess.length;
}
