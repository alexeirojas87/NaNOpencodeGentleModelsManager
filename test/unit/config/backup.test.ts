// WU4.3 (RED) — backup unit (SCW-4): every successful save has an
// exact-byte timestamped restore point; names carry the ISO stamp, newest
// KEEP_BACKUPS survive pruning, file mode is preserved, foreign files in the
// backup dir are never touched. Sandbox rule honored: everything happens
// inside a temp dir seeded from the fixture.
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BACKUP_DIR_NAME,
  KEEP_BACKUPS,
  backupConfig,
  defaultBackupDir,
} from '../../../server/src/config/backup';

const FIXTURE_PATH = fileURLToPath(
  new URL('../../fixtures/config.sample.json', import.meta.url),
);

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

function tempConfig(): { dir: string; configPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mdash-backup-'));
  tempDirs.push(dir);
  const configPath = join(dir, 'opencode.json');
  copyFileSync(FIXTURE_PATH, configPath);
  return { dir, configPath };
}

const ISO_NAME = /^opencode-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\.json$/;

describe('backup — contracts and defaults (SCW-4)', () => {
  it('exposes the backup-dir name, keep-20 policy and sibling default', () => {
    expect(BACKUP_DIR_NAME).toBe('model-dashboard-backups');
    expect(KEEP_BACKUPS).toBe(20);
    // Pure path math — backups live beside CONFIG, so CONFIG_PATH sandboxing
    // relocates them too (never ~/.config in tests).
    expect(defaultBackupDir('/tmp/x/opencode.json')).toBe(
      '/tmp/x/model-dashboard-backups',
    );
  });

  it('copies exact bytes under opencode-<ISO>.json, preserving mode', async () => {
    const { dir, configPath } = tempConfig();
    chmodSync(configPath, 0o600);
    const before = readFileSync(configPath, 'utf8');

    const res = await backupConfig(configPath);

    expect(dirname(res.path)).toBe(join(dir, BACKUP_DIR_NAME));
    expect(basename(res.path)).toMatch(ISO_NAME);
    expect(readFileSync(res.path, 'utf8')).toBe(before);
    expect(res.pruned).toBe(0);
    // Mode preserved — an 0600 apiKey config must not back up as 0644.
    expect(statSync(res.path).mode & 0o777).toBe(0o600);
  });

  it('restoring the newest backup reproduces exact pre-save bytes (SCW-4)', async () => {
    const { configPath } = tempConfig();
    const preSave = readFileSync(configPath, 'utf8');
    const first = await backupConfig(configPath);

    // Simulate a save mutating CONFIG, then back up again.
    writeFileSync(
      configPath,
      preSave.replace('"share": "manual"', '"share": "auto"'),
    );
    const second = await backupConfig(configPath);

    writeFileSync(configPath, readFileSync(second.path, 'utf8'));
    expect(readFileSync(configPath, 'utf8')).not.toBe(preSave);
    expect(readFileSync(first.path, 'utf8')).toBe(preSave);
  });
});

describe('backup — uniqueness and keep-20 pruning', () => {
  it('rapid consecutive backups never collide and stay chronological', async () => {
    const { dir, configPath } = tempConfig();
    const before = readFileSync(configPath, 'utf8');

    const paths: string[] = [];
    for (let i = 0; i < 12; i++) {
      paths.push((await backupConfig(configPath)).path);
    }

    expect(new Set(paths).size).toBe(12);
    const names = readdirSync(join(dir, BACKUP_DIR_NAME)).sort();
    expect(names).toEqual(paths.map((p) => basename(p))); // chronological == name order
    for (const p of paths) {
      expect(basename(p)).toMatch(ISO_NAME);
      expect(existsSync(p)).toBe(true);
      expect(readFileSync(p, 'utf8')).toBe(before);
    }
  });

  it('prunes to the newest KEEP_BACKUPS and never touches foreign files', async () => {
    const { dir, configPath } = tempConfig();
    const backupDir = join(dir, BACKUP_DIR_NAME);
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(backupDir, 'keepme.txt'), 'not a backup');

    const paths: string[] = [];
    for (let i = 0; i < KEEP_BACKUPS + 5; i++) {
      paths.push((await backupConfig(configPath, backupDir)).path);
    }

    const remaining = readdirSync(backupDir);
    expect(remaining).toContain('keepme.txt');
    const backups = remaining.filter((n) => n.startsWith('opencode-'));
    expect(backups.length).toBe(KEEP_BACKUPS);
    // The five OLDEST were deleted; the newest KEEP_BACKUPS remain.
    for (const gone of paths.slice(0, 5)) {
      expect(existsSync(gone)).toBe(false);
    }
    for (const live of paths.slice(5)) {
      expect(existsSync(live)).toBe(true);
    }
  });
});
