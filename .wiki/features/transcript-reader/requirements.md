# Reliable Transcript Reading — Requirements

> [Objective overview](00-overview.md)

## Problem & goal

The fullscreen transcript has app-managed paging and must keep a stable reading position while a streamed entry grows. Fullscreen remains the default interactive mode. The complete transcript remains available in session records, and active-session search is separate planned work.
## User stories

- As an Athena user, I want fullscreen transcript paging to let me review the conversation while the assistant is streaming.
- As an Athena user, I want new output to continue arriving without moving me away from older content I am reading.
- As an Athena user, I want to search the active conversation, including replies, user text, stored thinking, and tool activity, so I can find the relevant earlier detail.
- As an Athena user, I want search results labeled by kind and shown with enough surrounding text to recognize the match.

## Acceptance criteria

### Fullscreen transcript reading

- **Given** an interactive TTY in the default fullscreen mode and a transcript longer than its viewport, **when** PageUp is pressed, **then** the transcript moves toward earlier rows while fullscreen chrome stays pinned.
- **Given** the reader has paged away from the live tail, **when** a visible streaming entry grows below its first visible row, **then** that row remains fixed and the new tail does not yank the viewport.
- **Given** the reader pages down to the live tail, **when** new output arrives, **then** follow mode resumes.
- **Given** the user presses Ctrl+PageUp or Ctrl+PageDown, **then** the viewport jumps to the transcript beginning or live tail respectively.
- **Given** a fullscreen render at any terminal size, **then** pinned chrome fits its measured row budget and every-frame content-signature checks remain in force.
- **Given** a text entry or a bordered tool card is partially within the viewport, **then** text may be clipped at measured row boundaries but tool cards remain whole.
- **Given** output is redirected, **then** existing non-interactive behavior remains free of fullscreen control sequences.
### Search

- **Given** an active session with stored messages and tool activity, **when** the user searches for literal text, **then** Athena returns matching excerpts in chronological order with a role/activity label and enough context to identify each occurrence.
- **Given** text appears in user, assistant, stored thinking, or tool activity/output content, **when** that content is included in the session record, **then** it is searchable.
- **Given** a query with different letter casing, **when** searched, **then** matching is case-insensitive and literal; query punctuation is not treated as a regular expression.
- **Given** there are no matches, **when** the search completes, **then** Athena reports no matches without changing the session or making a provider call.
- **Given** a very common query or long session, **when** results exceed the display bound, **then** results are paged or bounded with a clear way to continue; output is not silently truncated.
- **Given** the session has provider-redacted or unavailable thinking, **when** the user searches, **then** Athena searches only stored content and does not imply omitted reasoning is searchable.

## Out of scope

- Search across all prior sessions, projects, or the future conversational-continuity index.
- Semantic search, ranking by relevance, remote indexing, or any network call.
- Changes to session retention, deletion, compaction, model context, or provider transmission.
- Exposing hidden or provider-omitted reasoning.

## Open questions

- Search interaction: slash command with next/previous result, or a small interactive search prompt. The design should fit existing command and input behavior while allowing the user to continue paging the fullscreen transcript.
- Whether tool request inputs and full tool outputs should both be in the first search corpus or whether very large outputs need an explicit per-kind inclusion option.
- Whether any additional terminal-specific interaction is needed beyond the existing fullscreen PageUp/PageDown bindings; verify on supported terminals without changing the fullscreen default.
