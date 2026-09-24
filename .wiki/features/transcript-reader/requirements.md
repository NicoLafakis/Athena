# Reliable Transcript Reading — Requirements

> [Objective overview](00-overview.md)

## Problem & goal

The fullscreen transcript has app-managed paging, but PageUp/PageDown is not working for the user. Classic mode claims native terminal scrollback, yet its redraw behavior can erase that history. As a result, a user cannot reliably browse or search the conversation that Athena is actively producing.

Done means normal terminal scrollback is the reliable default reader, streaming does not steal the user's scroll position, and the active session can be searched locally across the requested content kinds.

## User stories

- As an Athena user, I want conversation output to remain in ordinary terminal scrollback so I can use the same scrolling behavior as other CLI tools.
- As an Athena user, I want new output to continue arriving without moving me away from older content I am reading.
- As an Athena user, I want to search the active conversation, including replies, user text, stored thinking, and tool activity, so I can find the relevant earlier detail.
- As an Athena user, I want search results labeled by kind and shown with enough surrounding text to recognize the match.

## Acceptance criteria

### Normal terminal reading

- **Given** an interactive terminal and a conversation producing more output than fits on screen, **when** output is emitted, **then** it remains in terminal-native scrollback and can be traversed with that terminal's normal scroll controls.
- **Given** the user has scrolled above the live end, **when** another assistant, tool, or status entry is emitted, **then** the user's current reading position is preserved and the new content remains available at the live end.
- **Given** the user returns to the live end, **when** new output arrives, **then** reading follows the stream normally.
- **Given** a non-interactive or redirected output stream, **when** Athena runs, **then** output remains line-oriented and does not emit cursor-control sequences intended for an interactive terminal.
- **Given** fullscreen mode is selected, **when** the user chooses to use it, **then** its behavior is explicit and reliable; standard history access does not depend on custom key handling in that mode.

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

- Search interaction: slash command with next/previous result, or a small interactive search prompt. Technical design should select the option that fits existing command and terminal-input behavior while keeping native scrollback controls available.
- Whether tool request inputs and full tool outputs should both be in the first search corpus or whether very large outputs need an explicit per-kind inclusion option.
- The final default between append-only normal mode and a live TUI that uses an append-only transcript region; resolve by real-terminal prototype and usability verification before implementation is considered complete.
