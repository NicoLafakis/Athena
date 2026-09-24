# Reliable Transcript Reading — Product Requirements Document

> [Objective overview](00-overview.md) · [Requirements](requirements.md)

**Status:** planning
**Tier:** 3
**Surface:** local interactive CLI / TUI

## Summary

Make Athena's conversation history reliably readable in the terminal while it streams, and searchable within the active session. The reading surface should behave like a normal CLI: output stays in terminal scrollback and terminal-native scrolling works without depending on Athena intercepting PageUp/PageDown. Search runs locally over Athena's existing session records.

## Users and use cases

The primary user is Nico using Athena in an interactive terminal. He needs to review earlier user prompts, assistant replies, available thinking content, and tool activity while a run continues or after it completes. Redirected and CI use must retain clean line output.

## Functional requirements

1. **FR-1 — Durable reading surface:** Standard interactive mode SHALL leave completed conversation output in native terminal scrollback. The output may not be erased by a repaint loop.
2. **FR-2 — Streaming stability:** While the user is reading older output, new output SHALL continue to be recorded and SHALL NOT reset the terminal viewport to the tail.
3. **FR-3 — Live return:** The user SHALL be able to return to the latest output using the terminal's normal behavior; new output then continues naturally.
4. **FR-4 — Local active-session search:** Athena SHALL find literal case-insensitive matches in the active session's stored user, assistant, provider-supplied thinking, and tool activity/output content.
5. **FR-5 — Search results:** Each result SHALL identify its message/activity kind and include a bounded excerpt. Results SHALL be navigable or pageable, ordered chronologically, and report the count or remaining results.
6. **FR-6 — Scope and privacy:** Search SHALL be local, read-only, and use existing session data. It SHALL not send queries or transcript content to a model, telemetry sink, or external service.
7. **FR-7 — Terminal compatibility:** Redirected output SHALL remain free of interactive cursor-control sequences. Interactive scroll behavior SHALL be verified in supported Windows terminal environments and CI-supported operating systems.
8. **FR-8 — Thinking limits:** Search SHALL include only thinking/reasoning content that exists in the stored session. Provider-redacted, omitted, or non-persisted content is unavailable and must not be fabricated.

## Non-functional requirements

- Searching a normal active session should feel immediate; establish a measured local target during implementation using a large-session fixture.
- Rendering work must not grow with the entire session on every streamed token. Keep the terminal output path append-oriented and search work bounded/paged.
- No new dependency, remote service, transcript copy, or database migration is required by this PRD.
- Existing session data and old sessions remain readable without migration.
- Keyboard use remains possible without mouse support; terminal-native scroll controls must not be swallowed by Athena while normal reading mode is active.

## UX behavior

- Output flows in chronological order and the active assistant/tool output remains visibly current when the terminal is at the end.
- The user may scroll away using the terminal's standard controls. The renderer does not repaint away history or force-scroll the viewport.
- Search results are appended as ordinary local CLI output or presented in a terminal-native lightweight prompt; the selected option must preserve the user's ability to scroll the conversation.
- Existing fullscreen mode may remain available as an explicit alternate-screen presentation, but it is not the standard history reader.

## Data and privacy

The existing per-session record remains canonical. Any search index is derived, local, rebuildable, and contains no more content than needed to locate matches. Search queries and result snippets are not added to telemetry or sent to providers. Existing deletion semantics remain authoritative; any derived index must be removed/rebuilt consistently when source sessions are deleted.

## Error handling

- Missing or unreadable session content produces a concise local error and leaves the session untouched.
- An empty query is rejected or treated as a no-op with a clear prompt; it must not dump the full conversation.
- Excessive match counts are bounded with an explicit continuation path.
- Unsupported terminal features degrade to plain append-only output, never a fatal boot error.

## Success measures

- A long streamed turn remains available to native terminal scrollback after repeated updates.
- A user can scroll up during streaming, remain at the same historical content as output continues, and return to the end.
- Search finds known fixtures from each in-scope content kind, with no false claim of searching omitted thinking.
- Interactive and redirected sessions work across the project's supported OS matrix.

## Companion ADR

- [ADR 0001: terminal-owned scrollback and canonical session search](adr/0001-terminal-owned-transcript.md) — proposed; settle exact renderer shape after a real-terminal prototype.

## References

- [Fullscreen row budget and current scroll implementation](../../architecture/tui-fullscreen-row-budget.md)
- [Current TUI keybindings](../../reference/tui-keybindings.md)
- [Session manager](../../../src/harness/sessions.ts)
- [Transcript renderer](../../../src/tui/components/Transcript.tsx)
