// Higher-precedence OpenCode layer detection (warning surface).
// OpenCode 1.18.31 merges config lowest-to-highest: the GLOBAL
// ~/.config/opencode/opencode.json(c), then project files, then
// .opencode/opencode.json(c) dirs, then OPENCODE_CONFIG_DIR — appended LAST.
// The dashboard manages exactly one file (resolveConfigPath()); this module
// answers the only honest follow-up: "could a HIGHER layer silently override
// the file we manage?" A write that looks saved would still lose at runtime.
//
// PURE by contract: every existence question goes through the injected
// `pathExists`, so unit tests never touch the real filesystem. Deterministic
// order: OPENCODE_CONFIG_DIR overrides first, then the opencode.jsonc sibling.
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import type { ConfigOverride } from '../../../shared/types';

/** Candidate config file names inside an OpenCode config directory. */
const LAYER_CONFIG_FILES = ['opencode.json', 'opencode.jsonc'] as const;

/** The managed file name whose jsonc sibling would outrank it. */
const MANAGED_FILE_NAME = 'opencode.json';

/** Directory comparison key: drop trailing separators so /a/b/ matches /a/b. */
function sameDir(a: string, b: string): boolean {
  const strip = (p: string) => p.replace(/[/\\]+$/, '');
  return strip(a) === strip(b);
}

/**
 * Detect config layers that OpenCode loads AFTER the global config and that
 * therefore override the managed CONFIG. Never throws; tolerates malformed or
 * empty env values (an absent/blank OPENCODE_CONFIG_DIR contributes nothing).
 */
export function detectOverrides(
  env: Record<string, string | undefined>,
  managedPath: string,
  opts: { pathExists?: (p: string) => boolean } = {},
): ConfigOverride[] {
  const pathExists = opts.pathExists ?? existsSync;
  const overrides: ConfigOverride[] = [];

  // (a) OPENCODE_CONFIG_DIR — appended LAST by OpenCode, so it wins over
  // everything else. Only a DIFFERENT directory than the managed one counts;
  // pointing it at the managed dir is the same layer, not an override.
  const configDir = env.OPENCODE_CONFIG_DIR?.trim();
  if (configDir && !sameDir(configDir, dirname(managedPath))) {
    const layerFile = LAYER_CONFIG_FILES.map((name) =>
      join(configDir, name),
    ).find((candidate) => pathExists(candidate));
    overrides.push({
      kind: 'config_dir_env',
      path: layerFile ?? configDir,
      reason:
        'OPENCODE_CONFIG_DIR is loaded after the global config and overrides the managed CONFIG.',
    });
  }

  // (b) A sibling opencode.jsonc beside the managed opencode.json — OpenCode
  // merges it too, and its precedence beats the plain .json.
  if (basename(managedPath) === MANAGED_FILE_NAME) {
    const sibling = join(dirname(managedPath), 'opencode.jsonc');
    if (pathExists(sibling)) {
      overrides.push({
        kind: 'jsonc_sibling',
        path: sibling,
        reason:
          'This opencode.jsonc sits beside the managed opencode.json and takes precedence over it.',
      });
    }
  }

  return overrides;
}
