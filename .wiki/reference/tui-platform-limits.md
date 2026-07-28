# TUI platform limits

These are genuinely unreachable given Ink's input layer, each investigated and
deliberately not implemented. Recorded here so nobody re-litigates them from scratch.

## Mouse-wheel scrolling is not implemented

Ink owns stdin. Enabling terminal mouse-tracking mode without a consumer wired up to
interpret the resulting escape sequences injects that raw sequence straight into whatever
currently reads stdin — the input box — as garbage text. Transcript scrolling is
keyboard-only: PageUp/PageDown and Ctrl+PageUp/Ctrl+PageDown (see
[`tui-keybindings.md`](tui-keybindings.md)).

## Home/End and Ctrl+Home/Ctrl+End are not bindable

Ink's `useInput` key object surfaces no `home`/`end` boolean, and for every key its
vendored parser names (Home/End included) it blanks the `input` string. That collapses
Home/End to a shape indistinguishable from F1-F12 at the `useInput` seam — there is no
information left to distinguish them. Ctrl+Home/Ctrl+End fare no better: the parser maps
both to the same `name: 'home'`/`name: 'end'` with `ctrl` set, which Ink then collapses to
the same empty-`input`/ctrl-only shape as the un-modified keys.

Where jump-to-top / jump-to-live-tail is genuinely needed (Transcript scrolling),
Ctrl+PageUp/Ctrl+PageDown are used instead — `key.pageUp`/`key.pageDown` **do** survive
alongside `key.ctrl`, unlike Home/End.

## Delete key as forward-delete is not bindable directly

Ink's parser names **both** Backspace (`\x7f` on most hosts) and the real Delete key
(`\x1b[3~`) `'delete'`, with identical flags on both — there is no way to tell them apart
from inside the app. Binding the Delete key to forward-delete would therefore silently
turn every ordinary Backspace press into a forward delete as well. Forward-delete is
bound to **Ctrl+D** instead (the readline convention), which carries no such ambiguity.
See `deleteForward` in `src/tui/cursor.ts` and the input handler in
`src/tui/components/InputBox.tsx`.

## Ctrl+Backspace is gated on `WT_SESSION`

Windows Terminal delivers plain Backspace as DEL (`0x7f`, named `'delete'`) and
Ctrl+Backspace as BS (`0x08`, named `'backspace'`) — on WT the two are distinguishable,
so Ctrl+Backspace can safely bind to delete-word-backward there. Legacy conhost (and
other hosts) sends the same `0x08` byte for **plain** Backspace, where the identical test
would silently turn every single Backspace into a word-delete. That failure mode is bad
enough, and unverifiable from inside the app, that the binding is gated on the
`WT_SESSION` environment variable rather than assumed. Everywhere else, Ctrl+Backspace
simply degrades to an ordinary Backspace, and Ctrl+W remains the portable, always-safe
word-delete. See `isWordBackspaceKey` in `src/tui/cursor.ts`.
