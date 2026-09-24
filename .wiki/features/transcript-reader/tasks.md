# Reliable Transcript Reading — Implementation Plan

> [Objective overview](00-overview.md) · [Requirements](requirements.md) · [Technical design](design.md)

- [x] 1. Repair fullscreen transcript scrolling: retain the default fullscreen presentation and prove the reader remains on the same first visible row while a streaming entry grows. Files: `src/tui/`, focused TTY tests.
- [x] 2. Keep fullscreen row budgeting, pinned chrome, row-precise text clipping, and whole tool cards intact. Files: `src/tui/`, row-budget tests.
- [ ] 3. Implement active-session local search — search stored message blocks for literal case-insensitive matches and return bounded, labeled chronological excerpts with pagination. Files: `src/harness/sessions.ts` or a focused search helper, CLI command routing, tests. Done when: Requirements FR-4 through FR-6 and FR-8 pass.
- [ ] 4. Reconcile content coverage — verify whether tool progress, child-agent output, and thinking are in the canonical session record; search only stored content and document any excluded transient events. Done when: no UI claim exceeds persisted evidence.
- [ ] 5. Add interaction and error handling — choose the search invocation and next/previous or pagination behavior; handle empty query, no matches, unreadable sessions, and high match counts without changing session state. Done when: acceptance cases are covered.
- [x] 6. Update the authoritative scrolling docs, keybindings, fullscreen row-budget description, and wiki index. Search requirements remain planned separately.
- [x] 7. Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build` on the exact final tree before commit or push.
