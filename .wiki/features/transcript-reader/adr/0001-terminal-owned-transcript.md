# 0001. Keep fullscreen transcript paging as the default

**Status:** accepted
**Date:** 2026-09-24

> [Objective overview](../00-overview.md) · [Technical design](../design.md)

## Context

Athena intentionally enters fullscreen alternate-screen mode by default, like other terminal coding agents. The fullscreen transcript has app-managed paging and fixed chrome with a strict row budget. The defect addressed here is unstable reading position when a visible streaming entry grows beneath the viewport anchor. Session records remain canonical, and planned search must not create a competing archive or leak local content externally.
## Decision

Keep fullscreen mode as the default. Track the first visible transcript row with a top-relative `{ index, offset }` anchor. PageUp/PageDown move through the bounded fullscreen transcript; Ctrl+PageUp/Ctrl+PageDown jump to the beginning and live tail. Growth below the anchor preserves the visible row. Paging back to the live tail resumes follow mode.

Active-session search remains a separate planned capability over existing session records. It must stay local and report only content that Athena stores.
## Alternatives considered

- **Leave the existing bottom-relative anchor:** rejected because a growing entry changes its bottom and shifts the user's view.
- **Switch the default to classic mode:** rejected because fullscreen is the intended default and would change the product interaction contract.
- **Use the screen-reader presentation unchanged:** rejected because it has different prompt and semantic-announcement behavior; its append-only property is a reference, not a complete UI choice.
- **Persist a duplicate transcript index:** rejected because it adds privacy and deletion consistency risk.

## Consequences

- PageUp/PageDown and Ctrl+PageUp/Ctrl+PageDown control fullscreen transcript history.
- The transcript pager anchors to the first visible row; output below it can continue streaming.
- A TTY integration regression must prove that a visible streaming entry can grow without moving the reader or pinned chrome.
- Fullscreen remains the default reading mode; its row-budget invariants remain mandatory.
- Search results are only as complete as content stored in the existing session record. Provider-omitted reasoning remains unavailable.
