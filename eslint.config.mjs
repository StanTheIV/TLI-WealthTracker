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
//   don't trip it. The base ESLint rule is disabled to avoid double-reporting.
// - `no-explicit-any` errors: src has zero `any` today — lock that in. If a
//   boundary cast is ever unavoidable, use `unknown` or a justified disable.
// - `eqeqeq` and `import/no-duplicates` are added as high-value extras.
// - `import/no-restricted-paths` enforces process layering: `src/shared` is
//   pure and imports nothing else from src; renderer code never imports
//   `src/main`/`src/worker`; main and worker never import renderer dirs.
//   Tests and the replay harness are exempt.

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

      'import/no-restricted-paths': ['error', {zones: [
        {target: './src/shared', from: './src', except: ['./shared']},
        {
          target: ['./src/components', './src/state', './src/hooks', './src/windows', './src/theme', './src/i18n', './src/App.tsx', './src/main.tsx', './src/lib', './src/types'],
          from:   ['./src/main', './src/worker'],
        },
        {target: './src/main',   from: ['./src/components', './src/state', './src/hooks', './src/windows']},
        {target: './src/worker', from: ['./src/main', './src/components', './src/state', './src/hooks', './src/windows']},
      ]}],
    },
  },
  {
    files: ['src/replay/**', 'src/**/__tests__/**', 'src/test/**'],
    rules: {
      'import/no-restricted-paths': 'off',
    },
  },
];
