import tseslint from 'typescript-eslint'

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  // Root-level configs (eslint.config.js, tsup.config.ts, vitest.config.ts) are
  // linted: `pnpm lint` runs `eslint .`, and only build output and deps are ignored.
  // bin/athena.js is a launcher shim linted like everything else.
  { ignores: ['dist/**', 'node_modules/**'] },
)
