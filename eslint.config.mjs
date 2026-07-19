import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import importPlugin from 'eslint-plugin-import';

// ---------------------------------------------------------------------------
// Tuning notes
// ---------------------------------------------------------------------------
// - We spread @typescript-eslint's `recommended` (NON type-checked) rule set for
//   speed: no `project`-based type information is needed, so lint stays fast and
//   works headless in CI without a full type build. Type-checked variants
//   (and `no-floating-promises`) are deliberately NOT enabled.
// - `no-unused-vars` is delegated to the @typescript-eslint version with
//   argsIgnorePattern/varsIgnorePattern '^_' so intentionally-unused bindings
//   (e.g. the `_a`/`_b` type-sync assertions) don't trip it. The base ESLint
//   rule is disabled to avoid double-reporting.
// - `no-explicit-any` errors: src has zero `any` today — lock that in. If a
//   boundary cast is ever unavoidable, use `unknown` or a justified disable.
// - `eqeqeq` and `import/no-duplicates` are added as high-value extras.

export default [
  {
    ignores: ['dist/**', 'dist-electron/**', 'release/**', 'node_modules/**'],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        // No `project` here on purpose — keeps lint type-info-free and fast.
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {jsx: true},
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      import: importPlugin,
    },
    settings: {
      'import/resolver': {
        typescript: true,
        node: true,
      },
      'import/parsers': {
        '@typescript-eslint/parser': ['.ts', '.tsx'],
      },
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,

      // no-unused-vars: use the TS-aware version, ignore `_`-prefixed bindings.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      '@typescript-eslint/no-explicit-any': 'error',

      // High-value extras.
      eqeqeq: ['error', 'always', {null: 'ignore'}],
      'import/no-duplicates': 'error',
    },
  },
];
