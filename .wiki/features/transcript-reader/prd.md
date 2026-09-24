# Reliable Transcript Reading — Product Requirements Document

> [Objective overview](00-overview.md) · [Requirements](requirements.md)

**Status:** scrolling implemented; active-session search remains planned
**Tier:** 3
**Surface:** local interactive CLI / TUI

## Summary

Keep Athena's fullscreen alternate-screen TUI as the default and make transcript paging stable while entries stream. Active-session search remains a separate planned feature over existing session records.

## Users and use cases

The primary user is Nico using Athena in an interactive terminal. He needs to review earlier user prompts, assistant replies, available thinking content, and tool activity while a run continues or after it completes. Redirected and CI use must retain clean line output.

## Functional requirements

1. **FR-1 — Durable reading surface:** Fullscreen mode SHALL render a bounded transcript window and retain the complete conversation in canonical session records.
2. **FR-2 — Streaming stability:** While the user is reading older output, new rows appended below the first visible row SHALL NOT move that row or reset the fullscreen viewport to the tail.
3. **FR-3 — Live return:** PageDown SHALL return the user to the live tail; new output then continues to follow naturally.
4. **FR-4 — Local active-session search:** Athena SHALL find literal case-insensitive matches in the active session's stored user, assistant, provider-supplied thinking, and tool activity/output content.
5. **FR-5 — Search results:** Each result SHALL identify its message/activity kind and include a bounded excerpt. Results SHALL be navigable or pageable, ordered chronologically, and report the count or remaining results.
6. **FR-6 — Scope and privacy:** Search SHALL be local, read-only, and use existing session data. It SHALL not send queries or transcript content to a model, telemetry sink, or external service.
7. **FR-7 — Terminal compatibility:** Redirected output SHALL remain free of interactive cursor-control sequences. Fullscreen paging SHALL be verified with the TTY integration suite and existing cross-platform CI matrix.
8. **FR-8 — Thinking limits:** Search SHALL include only thinking/reasoning content that exists in the stored session. Provider-redacted, omitted, or non-persisted content is unavailable and must not be fabricated.

## Non-functional requirements

- Searching a normal active session should feel immediate; establish a measured local target during implementation using a large-session fixture.
- Rendering work must not grow with the entire session on every streamed token. Keep the visible fullscreen window bounded and search work bounded/paged.
- No new dependency, remote service, transcript copy, or database migration is required by this PRD.
- Existing session data and old sessions remain readable without migration.
- PageUp/PageDown and Ctrl+PageUp/Ctrl+PageDown remain keyboard reachable in fullscreen mode. Mouse wheel and Home/End remain unavailable at Ink's input seam.

## UX behavior

- Fullscreen alternate-screen mode remains the default interactive presentation.
- The live tail is visible by default. PageUp moves into history; PageDown returns toward live output and resumes following at the tail.
- A top-relative first-visible-row anchor keeps the reader in place when the current streaming entry grows below it.
- Search results, when implemented, must remain local, labeled, bounded, and navigable without changing the session.
## Data and privacy

The existing per-session record remains canonical. Any search index is derived, local, rebuildable, and contains no more content than needed to locate matches. Search queries and result snippets are not added to telemetry or sent to providers. Existing deletion semantics remain authoritative; any derived index must be removed/rebuilt consistently when source sessions are deleted.

## Error handling

- Missing or unreadable session content produces a concise local error and leaves the session untouched.
- An empty query is rejected or treated as a no-op with a clear prompt; it must not dump the full conversation.
- Excessive match counts are bounded with an explicit continuation path.
- Unsupported terminal key combinations remain documented limitations; they do not change the fullscreen default.

## Success measures

- A long streamed turn can be paged through in fullscreen after repeated updates, and a scrolled first-visible row stays fixed as the active entry grows.
- A user can page up during streaming, remain at the same historical row as output continues, and page down to resume following the end.
- Search finds known fixtures from each in-scope content kind, with no false claim of searching omitted thinking.
- Interactive and redirected sessions work across the project's supported OS matrix.

## Companion ADR

- [ADR 0001: fullscreen transcript paging with a stable row anchor](adr/0001-terminal-owned-transcript.md) — accepted.

## References

- [Fullscreen row budget and current scroll implementation](../../architecture/tui-fullscreen-row-budget.md)
- [Current TUI keybindings](../../reference/tui-keybindings.md)
- [Session manager](../../../src/harness/sessions.ts)
- [Transcript renderer](../../../src/tui/components/Transcript.tsx)
