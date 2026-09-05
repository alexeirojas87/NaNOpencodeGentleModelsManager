import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'coverage/**',
      '.atl/**',
      // Generated offline by tools/gen-schema.ts in WU3; not hand-linted.
      'shared/schema.generated.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // agent-pipelines WU-5: the standalone sandbox harnesses run under plain
    // node (not vitest), so their JS environment needs the Node globals —
    // the TS project gets them through typescript-eslint's no-undef off-switch.
    files: ['test/harness/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      // The harnesses strip ANSI color codes from subprocess output — the
      // control-character regexes are the point, not an accident.
      'no-control-regex': 'off',
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
