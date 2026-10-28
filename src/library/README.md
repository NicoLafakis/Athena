# Project librarian

Implemented source module, disabled by default. The installed Athena build and all
personal harness files remain unchanged.

See [architecture, policy, invocation and limitations](../../.wiki/architecture/librarian-library.md).

Components: `core.ts` (contracts), `store.ts` (atomic persistence), `config.ts`
(explicit public-source opt-in), `verifier.ts` (actual Git/check evidence),
`runtime.ts` (librarian service), `cli.ts` (operator controls), and
`../tools/library.ts` (model-facing adapters). The shared controller mounts tools
only for an opted-in trusted project and supplies revalidated ephemeral context.

Existing-dependency checks:

    node node_modules/vitest/vitest.mjs run tests/library --cache=false
    node node_modules/typescript/bin/tsc --noEmit
    node node_modules/eslint/bin/eslint.js src/library src/tools/library.ts tests/library

No provider, scheduler, global storage or active build is enabled by these checks.
