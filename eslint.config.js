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
  //
  // `.claude/**` is the agent harness scratch, and isolated agent worktrees live at
  // `.claude/worktrees/<id>/` — each one a full nested checkout of this repo, with its
  // own `src/` and its own `dist/`. Without this pattern `eslint .` lints a second copy
  // of everything and reports failures from another agent's tree against this one. The
  // `dist/**` pattern above does not cover it: that dist sits at
  // `.claude/worktrees/<id>/dist/`, not at the root. Mirrors the `.claude/` entry in
  // `.gitignore`.
  { ignores: ['dist/**', 'node_modules/**', '.claude/**'] },
)
