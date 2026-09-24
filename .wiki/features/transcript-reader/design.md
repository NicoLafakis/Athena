# Reliable Transcript Reading — Technical Design

> [Objective overview](00-overview.md) · [Requirements](requirements.md) · [PRD](prd.md)

## Current evidence

- `src/tui/App.tsx` defaults interactive TTY sessions to fullscreen alternate-screen mode and owns an app-managed `scrollAnchor` pager.
- `src/tui/components/Transcript.tsx` renders user, assistant, system, thinking, and tool entries. Thinking display is tail-capped to eight measured rows.
- `src/tui/viewport.ts` virtualizes the fullscreen viewport and computes PageUp/PageDown movement.
- The keybinding page documents app-managed PageUp/PageDown and Ctrl+PageUp/Ctrl+PageDown. Fullscreen is the intentional default; streaming growth must not move the first visible row.
- The fullscreen transcript is rendered as a bounded row window, and fixed chrome is budgeted separately.
- `SessionManager.search(query)` searches session titles and serialized stored messages, returning matching sessions. It does not return in-session excerpts or navigate within a session.
- `ScreenReaderPresentation` writes append-only assistant output and uses serialized line input. It is a separate accessibility presentation, not a drop-in replacement for the standard interactive prompt.

## Approach

Keep the existing fullscreen TUI as the standard interactive presentation. Use PageUp/PageDown to move through the bounded transcript and Ctrl+PageUp/Ctrl+PageDown for jumps. Track the first visible row with a top-relative `{ index, offset }` anchor; this keeps the reading position fixed when a streaming entry grows below it. Returning to the live tail resumes follow mode.

Use existing session records as the authoritative source for the separately planned active-session search. Search must inspect stored message blocks and tool request/result content, return bounded excerpts, and remain local. Do not persist a second raw transcript or send queries/content to a provider.
## Data flow

```text
engine events ──> session messages / existing session JSONL ──> fullscreen virtualized transcript
                                                    └─────────> local active-session search
                                                                  └─> labeled excerpts
```

Tool activity that is not part of the stored conversation record may continue to appear in the live display, but search coverage must be stated accurately. The implementation must verify which tool progress and child-agent events are persisted before claiming them searchable.

## Data model

No session schema change is planned. Search results are transient values containing session ID, message or block position, content kind, and a bounded excerpt. Any acceleration structure must be derived and rebuildable from the existing records, must not become a second source of truth, and must honor session deletion.

## Terminal and rendering contract

- Fullscreen interactive mode renders a bounded transcript viewport; PageUp/PageDown navigate its row window.
- When the user is scrolled away from the live tail, new rows appended below the first visible row must not move that row.
- Prompt/input updates keep their fixed fullscreen position while the transcript window changes.
- Non-TTY output never emits cursor-control sequences.
- Fullscreen alternate-screen mode remains the default and uses the bounded viewport and custom keys.
- Do not use row-count-only assertions to claim fullscreen safety. If fullscreen code changes, retain the every-frame content-signature tests required by the repo.

## Search contract

- Search source: active session's existing in-memory/stored message blocks, including user text, assistant text, stored thinking/redacted markers, and stored tool inputs/results.
- Matching: literal, case-insensitive substring; no regex evaluation and no provider call.
- Results: chronological, labeled, bounded excerpt plus a stable message/block locator; bounded pagination for high match counts.
- Empty or whitespace-only query does not dump content.
- Redacted or absent thinking remains absent; no attempt to reconstruct it.
- Search errors are local and actionable without printing raw stack traces or stored secrets.

## Alternatives considered

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| Keep the fullscreen pager as the primary reader | Preserves the intentional default fullscreen interaction and fixed chrome | Requires correct row anchoring while a streamed entry grows | Keep and make the anchor stable |
| Keep classic Ink mode as the primary reader | Simple alternative | Does not match the intentional fullscreen default | Rejected for this task |
| Top-relative fullscreen viewport anchor | Keeps the exact visible row steady during streaming and works with the existing TUI | Requires row-aware anchoring and whole tool-card handling | Chosen |
| Reuse screen-reader presentation wholesale | Already append-only and bounded | Different prompt/accessibility contract; semantic announcements are not a complete transcript view | Reuse principles only; do not silently change accessibility mode |
| Copy transcripts into a dedicated search archive | Fast independent indexing | Duplicates sensitive content and creates retention/deletion synchronization | Reject |

## Cross-cutting

- **Privacy:** local-only search, no query or excerpt telemetry, no provider calls.
- **Accessibility:** append-only output remains compatible with screen readers; keep semantic announcements distinct from transcript text.
- **Performance:** do not rerender all prior transcript text per token. Bound result excerpts and paginate.
- **Compatibility:** verify PowerShell/Windows Terminal and at least one POSIX terminal; account for terminal-specific paging controls. Fullscreen PageUp/PageDown bindings control transcript history; platform limits are documented separately.
- **Documentation:** update the current keybindings and fullscreen row-budget pages if implementation changes their behavior. Keep the wiki index aligned.
