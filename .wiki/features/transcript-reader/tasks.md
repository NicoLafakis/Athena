# Reliable Transcript Reading — Implementation Plan

> [Objective overview](00-overview.md) · [Requirements](requirements.md) · [Technical design](design.md)

- [x] 1. Repair fullscreen transcript scrolling: retain the default fullscreen presentation and prove the reader remains on the same first visible row while a streaming entry grows. Files: `src/tui/`, focused TTY tests.
- [x] 2. Keep fullscreen row budgeting, pinned chrome, row-precise text clipping, and whole tool cards intact. Files: `src/tui/`, row-budget tests.
- [x] 3. Implement active-session local search — search stored message blocks for literal case-insensitive matches and return bounded, labeled chronological excerpts with pagination (`src/harness/transcript-search.ts`, `/search <query> [--page <n>]`).
- [x] 4. Reconcile content coverage — searches only stored `user`, `assistant`, `thinking`, `tool_use`, and `tool_result` blocks in the active session record; transient unpersisted progress events are not claimed searchable.
- [x] 5. Add interaction and error handling — `/search <query> [--page <n>]` wired into shared slash routing (Ink + screen-reader parity); empty query, no matches, and pagination handled cleanly without mutating session state.
- [x] 6. Update the authoritative scrolling docs, keybindings, fullscreen row-budget description, and wiki index.
- [x] 7. Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build` on the exact final tree before commit or push.
