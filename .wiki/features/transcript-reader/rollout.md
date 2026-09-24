# Reliable Transcript Reading — Rollout and Recovery

> [Objective overview](00-overview.md) · [PRD](prd.md)

## Release shape

No data migration or feature flag is planned. Fullscreen alternate-screen mode remains the default interactive experience. The scrolling change updates the viewport anchor used while paging and preserves session records and chrome budgeting.

## Before release

- Confirm all four repository gates pass on the final tree.
- Run the fullscreen TTY regression that pages into a long streaming entry, appends rows below the viewport, and confirms the first visible row stays fixed.
- Verify redirected output contains no terminal control sequences.
- Verify active-session search for stored user, assistant, thinking, and tool blocks, plus no-results and high-match cases.
- Confirm search output and logs do not persist queries or excerpts outside the existing session record.

## Recovery

If fullscreen paging or streaming stability regresses, revert the viewport-anchor change while retaining the existing fullscreen renderer and row-budget safeguards. Do not clear or rewrite session files as part of rollback. Search can be disabled independently if it returns incorrect or unsafe excerpts; existing session records remain unchanged.

## Data changes

None planned. If implementation adds a derived index, it must be rebuildable from session records and removable without changing conversation data. A migration plan is not applicable unless that decision changes.
