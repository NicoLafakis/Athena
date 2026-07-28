# TUI keybindings

## Input box editing

The input box has a real block cursor (`src/tui/cursor.ts`), not append-at-end-only.
`value` is a single flat string that may contain `\n` (backslash-continuation); the
cursor is a single flat index into it, never a `[row, col]` pair.

| Key | Action |
| --- | --- |
| Left / Right arrow | Move cursor one character |
| Ctrl+Left / Ctrl+Right, or Meta+Left / Meta+Right | Move cursor one word (`prevWordBoundary`/`nextWordBoundary`) |
| Meta+B / Meta+F | Word motion alias (readline-style ESC-prefixed hosts that send `\x1b b`/`\x1b f`) |
| Ctrl+A | Move to start of current line (not start of whole buffer — respects `\n`) |
| Ctrl+E | Move to end of current line |
| Backspace | Delete character before cursor |
| Ctrl+D | Delete character at cursor (forward-delete; see [platform limits](tui-platform-limits.md) for why the Delete key itself isn't bound) |
| Ctrl+W | Delete word before cursor |
| Ctrl+Backspace | Delete word before cursor — Windows Terminal only (`WT_SESSION`); degrades to plain Backspace elsewhere, see [platform limits](tui-platform-limits.md) |
| Up / Down arrow | Recall previous/next submitted line from history (when not inside an open popup) |
| `text` + `\` + Enter | Backslash-continuation: strips the trailing `\`, inserts a newline, keeps composing |
| Enter | Submit |
| Esc | Abort the current turn (only while a turn is busy) |

Any cursor motion or word-delete dismisses an open `@`-mention or `/`-command popup,
since both derive their filter query from an assumption that the cursor sits at the end
of the armed text.

## `@`-mention popup (files and agents)

| Key | Action |
| --- | --- |
| Up / Down arrow | Move highlighted candidate |
| Tab / Enter | Insert the highlighted candidate |
| Backspace | Delete a character; closes the popup once the triggering `@` itself is deleted |
| Esc | Close, keep the typed `@query` as literal text |

## `/`-command menu (live, arms only as the very first character of an empty box)

| Key | Action |
| --- | --- |
| Up / Down arrow | Move highlighted command |
| Tab | Complete the highlighted command name (or open its value picker if pickable and nothing's left to type) |
| Enter | Same as Tab, except an exact, fully-typed command name always wins over whatever the cursor happens to be highlighting, and — for a non-pickable command with nothing left to complete — falls through to ordinary submit |
| Backspace | Delete a character; closes the menu once the leading `/` itself is deleted |
| Esc | Close, keep the typed `/query` as literal text |

## Second-level value picker (`/model`, `/provider`, `/effort`, `/mode`, `/tui`)

Opened by typing one of those five command names bare (no trailing argument) and
pressing Enter/Tab, or by selecting one from the `/`-menu.

| Key | Action |
| --- | --- |
| Up / Down arrow | Move highlighted value |
| Enter | Confirm the highlighted value and dispatch it |
| Esc | Cancel, no change |

If the terminal is too short to draw even a one-row picker, the picker is cancelled
outright rather than left armed-but-invisible — App emits an info line naming the typed
fallback (e.g. `/model <value>`). `argPicker !== null` in `App.tsx` always means "the
picker is up": there is no state where it's armed but not drawn and silently swallowing
Up/Down/Enter/Esc.

## Transcript scrolling (fullscreen mode only)

Fullscreen-only because classic mode keeps native terminal scrollback, which these keys
would otherwise fight with. See
[the row-budget architecture page](../architecture/tui-fullscreen-row-budget.md) for how
the scroll window is computed, and [platform limits](tui-platform-limits.md) for why
Home/End aren't available as an alternative to the Ctrl+PageUp/PageDown bindings below.

| Key | Action |
| --- | --- |
| PageUp | Scroll up roughly one screen (with a 1-row overlap for reader continuity) |
| PageDown | Scroll down roughly one screen; scrolling past the last entry resumes following the live tail |
| Ctrl+PageUp | Jump to the top of the transcript |
| Ctrl+PageDown | Jump to the live tail (equivalent to un-scrolling) |

New messages never yank a scrolled-up view back down to the tail — auto-follow only
applies while `scrollEnd` is at its default (`null`, meaning "following the live tail").

## Global

| Key | Action |
| --- | --- |
| Esc | Abort the current turn, if one is running; also cancels any queued sub-agent permission prompts |
