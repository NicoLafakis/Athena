# Reliable Transcript Reading — Technical Design

> [Objective overview](00-overview.md) · [Requirements](requirements.md) · [PRD](prd.md)

## Current evidence

- `src/tui/App.tsx` defaults interactive TTY sessions to fullscreen alternate-screen mode and owns an app-managed `scrollAnchor` pager.
- `src/tui/components/Transcript.tsx` renders user, assistant, system, thinking, and tool entries. Thinking display is tail-capped to eight measured rows.
- `src/tui/viewport.ts` virtualizes the fullscreen viewport and computes PageUp/PageDown movement.
- The existing keybinding page describes PageUp/PageDown and Ctrl+PageUp/PageDown. The user reports that paging does not work in their terminal.
- `/tui classic` returns to normal terminal mode, but `.wiki/architecture/tui-fullscreen-row-budget.md` records that Ink's `clearTerminal` can erase classic scrollback during repaint.
- `SessionManager.search(query)` searches session titles and serialized stored messages, returning matching sessions. It does not return in-session excerpts or navigate within a session.
- `ScreenReaderPresentation` writes append-only assistant output and uses serialized line input. It is a separate accessibility presentation, not a drop-in replacement for the standard interactive prompt.

## Approach

Make ordinary terminal scrollback the default history reader. The renderer must append stable transcript output rather than repainting the whole conversation in a way that erases terminal history. Keep only the currently streaming item mutable; when it completes, commit it to the append-only display. Keep `/tui fullscreen` as an explicit alternate-screen option if it remains useful, and do not depend on custom paging bindings for standard reading.

Use the existing session record/messages as the authoritative searchable source. Add an active-session search operation that walks stored message blocks and tool request/result content, then returns bounded excerpts with stable source positions and kind labels. Do not search only the currently rendered viewport: that omits clipped or virtualized content. Do not persist a second raw transcript or send queries/content to a provider.

The interaction details for starting search and moving through results remain a small design pen. Prefer an existing slash-command entry point with next/previous result commands if that supports paging through results without taking over native scroll keys. If live navigation inside the terminal proves necessary, prototype it before committing to a more complex alternate-screen reader.

## Data flow

```text
engine events ──> session messages / existing session JSONL ──> append-only terminal reader
                                                    └─────────> local active-session search
                                                                  └─> labeled excerpts
```

Tool activity that is not part of the stored conversation record may continue to appear in the live display, but search coverage must be stated accurately. The implementation must verify which tool progress and child-agent events are persisted before claiming them searchable.

## Data model

No session schema change is planned. Search results are transient values containing session ID, message or block position, content kind, and a bounded excerpt. Any acceleration structure must be derived and rebuildable from the existing records, must not become a second source of truth, and must honor session deletion.

## Terminal and rendering contract

- Standard interactive mode writes transcript history through a terminal-safe append path; terminal-native scrollback owns the historical viewport.
- New output may extend the live tail but must not clear/repaint prior transcript rows or reset a user-scrolled viewport.
- Prompt/input updates must not rewrite historical transcript output. Keep the prompt interaction independent from finalized transcript rows.
- Non-TTY output never emits cursor-control sequences.
- Fullscreen alternate-screen mode remains explicit and may continue to use the existing bounded viewport and custom keys.
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
| Keep the fullscreen pager as the primary reader | Rich fixed layout and precise custom viewport | Depends on key delivery the user reports is broken; terminal's normal scroll behavior is not available | Keep as optional mode, not the default history path |
| Keep classic Ink mode and assume native scrollback | Smallest product change | Current documentation records scrollback erasure during redraw | Reject until append behavior is proven |
| Append-only transcript with terminal-owned scrollback | Matches normal CLI behavior; scroll keys stay terminal-owned; old rows are stable | Requires separating finalized output from mutable prompt/live output; terminal-specific smoke testing | Preferred; validate with prototype |
| Reuse screen-reader presentation wholesale | Already append-only and bounded | Different prompt/accessibility contract; semantic announcements are not a complete transcript view | Reuse principles only; do not silently change accessibility mode |
| Copy transcripts into a dedicated search archive | Fast independent indexing | Duplicates sensitive content and creates retention/deletion synchronization | Reject |

## Cross-cutting

- **Privacy:** local-only search, no query or excerpt telemetry, no provider calls.
- **Accessibility:** append-only output remains compatible with screen readers; keep semantic announcements distinct from transcript text.
- **Performance:** do not rerender all prior transcript text per token. Bound result excerpts and paginate.
- **Compatibility:** verify PowerShell/Windows Terminal and at least one POSIX terminal; account for terminal-specific paging controls. The terminal, not Athena, should own normal scrolling.
- **Documentation:** update the current keybindings and fullscreen row-budget pages if implementation changes their behavior. Keep the wiki index aligned.
