# TUI fullscreen row budget

Fullscreen mode (the alternate-screen buffer Athena defaults to on a real interactive
TTY; `/tui classic` reverts to native scrollback) renders every visible thing inside a
single `Box flexDirection="column" height={rows}` — one fixed-height column whose height
is exactly the terminal's current row count. This page documents the invariant that
layout depends on, why it exists, and the rule for anyone adding new chrome.

## The invariant

Only one child of that column has `overflow="hidden"`: the `Box` wrapping `Transcript`.
Every other sibling — `Banner`, `TodoPanel`, `PermissionDialog`, `BusyIndicator`,
`ArgPickerPopup`, `InputBox` (and, inside `InputBox`, `MentionPopup`/`SlashMenuPopup`),
and `StatusLine` — is **unclipped**. Ink/Yoga does not reflow or clip an unclipped sibling
when the column's total content height exceeds `rows`. It corrupts the frame: dropped or
interleaved lines, headers pushed off-screen, stale content left behind. There is no
error, no exception, nothing to catch — the terminal just renders garbage.

Given that, the row budget has to be exact, with zero slack: the sum of every sibling's
actual rendered height must never exceed `rows`. `src/tui/App.tsx` computes that budget
explicitly, sibling by sibling, every render, rather than trusting any component to
self-limit.

## Precedence order, and the oscillation it prevents

The budget is computed in a fixed order, each step consuming from what's left:

1. `StatusLine` — fixed footer, measured against the actual wrapped text width
   (`wrappedRowCount`, not an assumed "always 1 row" — a long cwd or truncated tool-input
   summary can wrap on a narrow terminal).
2. The `MIN_TRANSCRIPT_ROWS` floor (3) — Transcript never drops below this, though it's
   safe to let it, because Transcript is the one sibling `overflow="hidden"` actually
   protects.
3. `Banner` — ambient branding, steps aside entirely (`bannerFits`) if it doesn't fit
   alongside the footer and the transcript floor.
4. `BusyIndicator` — only while a turn is running and nothing's blocking it.
5. `InputBox` — gets a ceiling (`inputMaxRows`) computed from steps 1-4, and reports back
   its *actual* height (`inputRows`) for the very same render — see "InputBox measures
   itself in the same render" below.
6. Everything downstream (`ArgPickerPopup`, `TodoPanel`, `PermissionDialog`'s diff view) is
   budgeted from what's left **after** `inputRows`, not from the ceiling handed to
   `InputBox`.

Step 6 depending on `inputRows` (the actual value) rather than `inputMaxRows` (the
ceiling) is deliberate and is what keeps the system from oscillating. If `inputMaxRows`
depended on `ArgPickerPopup`/`TodoPanel`'s size, and their size depended in turn on how
much room `InputBox` used, the two would chase each other's output every render (popup
opens → panel shrinks → more room → popup grows → …) instead of settling on one answer.

## InputBox measures itself in the same render — there is no `onHeightChange` anymore

An earlier version of this budget had `InputBox` report its height back to `App` through
an `onHeightChange` callback prop, written into an `inputRows` React state. That round
trip is gone, and it was removed because it caused a real, reproduced defect, not as a
style cleanup.

A callback can only ever report a height *after* the commit that already rendered (and
wrote to the terminal) at that height — one full frame late. That lag was invisible while
the box only ever grew by a single text row per keystroke. It stopped being invisible the
moment an overlay popup could open in one keystroke and jump the height by roughly 12
rows: for that one committed frame, every sibling budgeted from `inputRows` (`TodoPanel`,
`ArgPickerPopup`, the Transcript window) was still sized against the *old*, smaller
height. Typing `@` with a `TodoPanel` visible overshot the row budget by ~12 rows for
exactly one frame — reproduced, not hypothetical.

The fix was to stop having two sources of truth. `InputBox` is now a hook,
`useInputBox(props) → { rows, element }`, called directly inside `App`'s render body.
`App` gets `rows` as a plain return value in the *same* render pass it uses to budget
`TodoPanel`, `ArgPickerPopup`, and the Transcript window — there is no second render, no
callback, and no `inputRows` state in `App` to lag behind it. `onHeightChange` no longer
exists on `InputBoxProps`.

A thin `InputBox` component (`export function InputBox(props) { return
useInputBox(props).element }`) remains as a wrapper around the hook, kept only for
callers that don't need to budget any other sibling against the box's height — classic
mode's shape, and focused `InputBox` unit tests. `App.tsx` does not use it; it calls
`useInputBox` directly.

The anti-oscillation property from the precedence order above is unchanged and still
structural: `inputMaxRows` (the ceiling handed *in* to `useInputBox`) must never be
derived from `TodoPanel`/`ArgPickerPopup` (which are budgeted *out* of the height the hook
reports), or the same feedback loop reappears with a different mechanism.

## The reserve-exactly-what-you-render rule

Every one of the three overlay popups (`MentionPopup`, `SlashMenuPopup` inside
`InputBox`; `ArgPickerPopup` as an `App`-level sibling) shares one row-math
implementation, `popupLayout` in `src/tui/popupWindow.ts`. That function is the single
source of truth for **both** what a popup renders and how tall the budget reserves for
it — the number a component draws and the number subtracted from the budget can never
disagree, because they come from the same call. `popupLayout` shrinks the visible item
window to fit whatever `maxRows` is handed to it, and returns `null` (render nothing, cost
nothing) when even a one-row popup wouldn't fit. A popup showing fewer items, or none, is
correct; a corrupted frame is not.

The same discipline governs text-bearing chrome: `PermissionDialog`'s header/summary/
reason/footer and each `TodoPanel` line are measured with `wrappedRowCount` against the
*actual current terminal width*, not assumed to be one row. This is exactly how the
original corruption bug happened — for row-count overflow rather than character-wrap
overflow — so `viewport.ts`'s `wrappedRowCount`/`estimateEntryRows` machinery (already
used for `Transcript`) is reused everywhere else that renders variable-width text.

`PermissionDialog`'s header/footer are never truncated; summary/reason are capped to a
small bounded number of rows (`DIALOG_SUMMARY_MAX_ROWS`/`DIALOG_REASON_MAX_ROWS`) rather
than hidden outright, so "Permission required" always renders in full — the diff view (or,
at the extreme, a shred of `Transcript`) is what shrinks first.

## Chrome measures itself instead of asserting constants

Several pieces of "fixed" chrome used to budget a constant instead of measuring their
actual rendered height, and every one of those constants turned out to be wrong on some
terminal size:

- `Banner`'s row count used to be a hardcoded `BANNER_ROWS = 4`. It was factually wrong:
  the banner's info row carries the cwd, which routinely wraps on its own, and the
  Greek-key border rules are clamped to a `MIN_WIDTH`, so they wrap too below that width.
  On a 30-column terminal the old constant undercounted by 2 or more rows. It's replaced
  by `bannerRowCount()` in `src/tui/components/Banner.tsx`, which measures the actual
  wordmark, both border rules, and the info row (`bannerInfoText`) with `wrappedRowCount`
  against the real terminal width — "a fixed number of `<Text>` children" and "a fixed
  number of rows" are not the same claim.
- `StatusLine` used to be a flex-ROW `Box` of sibling `<Text>` segments, each of which
  wrapped independently — a shape whose real height a single concatenated string
  (`statusLineText`) cannot model, and which visibly drew the cwd segment through the
  other segments once it wrapped. It's now a single `<Text>` with nested inline colored
  spans, so the whole line wraps as one flow of text and `statusLineText`'s estimate is
  exact by construction, not by luck at 80 columns.
- The "+N more" truncation notice reservation (`diffNoticeText`/`todoNoticeText`) was not
  monotonic in the hidden count: past a certain length both notices fall back from a
  verbose two-row form to a short one-row form, so a *larger* placeholder count could
  yield a *shorter* reserved notice. The old pessimistic placeholder (`999`/`999_999`)
  therefore reserved 1 row while the real `+1 more (widen terminal…)` rendered 2.
  `noticeReserveRows()` in `App.tsx` now takes the max of measuring both ends of the range
  (count `1` and the placeholder), which covers every count in between because the
  verbose form's length is monotonic in digit count.
- `estimateEntryRows` (`viewport.ts`) no longer hardcodes `case 'system': return 1` — long
  system lines (a compaction summary, an error, a background-task line) were undercounting
  the Transcript virtualization window by a row apiece.

## Text measurement is display-width and wrap aware

`wrappedRowCount` (`viewport.ts`) used to count UTF-16 code units and ignore that
wrapping breaks at whitespace. Both were real undercounts: CJK characters and most emoji
occupy two terminal columns per code unit, and text narrower than `columns * n` characters
can still need `n + 1` rows once wrapping is accounted for. It now short-circuits any line
that already fits (`displayWidth(line) <= width`), and otherwise measures with the exact
wrapper Ink itself uses, `wrapAnsi(text, columns, { trim: false, hard: true })`, with a
printable-ASCII fast path (`displayWidth`) for the overwhelmingly common case where
`.length` already equals the display width. `truncateTextToRows` binary-searches the
longest *grapheme* prefix (not code-unit or code-point prefix) that still fits within the
row ceiling, so a truncation boundary can never split a surrogate pair or a ZWJ emoji
sequence. `string-width` and `wrap-ansi` are now direct dependencies of the project
(previously pulled in only transitively via Ink) — this matters because a CJK- or
emoji-bearing popup line that character-counted as "one row" could wrap to two and
silently blow the budget, exactly the failure class this whole system exists to close.

## Row-count assertions cannot detect this class of bug — read this before "verifying" anything here

This is the single most important thing to understand about this system, and it is not
obvious from the invariant statement above. Read it before writing a test, a manual
check, or a "looks fine" verification of anything that touches this budget.

The root `Box` is `height={rows}`, and Ink's `Box` defaults to `flexShrink: 1`. When the
combined natural height of its unclipped children exceeds `rows`, Yoga does **not**
produce a taller frame that a height check would catch. It shrinks the oversized
siblings to fit, and Ink then draws their content over one another — dropped or
interleaved lines, a wordmark fused onto its own border rule, a `TodoPanel` missing
items, the input line struck through a popup's edge. **A corrupted frame still measures
exactly `rows`.** Nothing about its height is wrong. Anyone who "verifies" this budget by
asserting the captured frame's row count — including a plausible-looking regression test
— is measuring the one property that a corrupted frame gets right, and will get a false
pass on exactly the bug this whole system exists to prevent.

Detection requires checking frame *content*, not frame height: a content signature that
can only be true of an uncorrupted frame. `expectEveryFrameSound` in
`tests/tui/fullscreen-popup-overflow.test.tsx` is that check — it asserts things like "the
banner wordmark occupies its own row" and "the visible todos form a contiguous prefix of
the real list", and it asserts them over **every frame ink-testing-library captured
during the test, not just the last (settled) one.** A transient one-frame corruption (like
the `onHeightChange` lag described above) only ever shows up in an intermediate frame; a
test that only inspects the final frame is blind to it by construction, on top of being
blind to content in the first place.

Reproducing this class of bug also has a real precondition: the `TodoPanel` has to be
large enough that truncation actually engages — around 20 todos in the test fixtures. At
4-6 todos the stale (lagging) budget and the correct one happen to agree, and the bug
hides. If you're chasing a suspected regression here and it isn't reproducing, check the
fixture size before concluding it's fixed.

## Rule for future chrome

**Any new fullscreen chrome must be budgeted the same way, or it will eventually corrupt
the frame on some terminal size.** Concretely:

- New chrome goes into the precedence chain above at the point that matches its
  priority (fixed/ambient chrome near the top, content-driven chrome near the bottom).
- If it renders variable-length text, measure it with `wrappedRowCount` against the real
  terminal width — never assume one row.
- If it's a popup with a scrollable item list, reuse `popupLayout`/`popupLine` from
  `popupWindow.ts` rather than inventing a second window/truncation implementation.
- The number subtracted from the budget and the number actually rendered must come from
  the same computation. Never estimate one and render the other.

This has already caused one ship-blocking incident (frame corruption from an unbudgeted
sibling) and is the single easiest thing for a future contributor to break, because
nothing short of running the app at a genuinely small terminal size surfaces the failure
— it does not show up as a type error, a lint failure, or a unit test failure unless the
test specifically renders at a constrained `rows`/`columns` (see
`tests/tui/fullscreen-popup-overflow.test.tsx` and `tests/tui/app-scroll.test.tsx`).

## Transcript scrolling

Transcript scroll position is tracked as `scrollEnd`, the exclusive entry index the
render window ends at (`null` = following the live tail). An index, not a row offset from
the bottom, because appending new entries at the tail can never move an index that points
behind it — a row-offset anchor would need to be re-derived on every new message just to
stay pointed at the same logical spot. `shiftWindowEnd`/`sliceToRows` in `viewport.ts` do
the index math; `estimateEntryRows` (the same estimator `Transcript` slices with) is what
a page step measures against, so a page step and the window it produces can never
disagree about how tall an entry is.

Scrolling is fullscreen-only — classic mode keeps native terminal scrollback and is left
alone. See `.wiki/reference/tui-keybindings.md` for the PageUp/PageDown/Ctrl+PageUp/
Ctrl+PageDown bindings and `.wiki/reference/tui-platform-limits.md` for why Home/End
aren't bound.

## Source map

- `src/tui/App.tsx` — the budget itself (see the large file-header comment there, which
  this page expands on), the precedence chain, `noticeReserveRows`.
- `src/tui/components/InputBox.tsx` — `useInputBox` (the hook `App.tsx` calls directly),
  and the thin `InputBox` component wrapper around it for callers that don't need `rows`.
- `src/tui/components/Banner.tsx` — `bannerRowCount`, `bannerInfoText`.
- `src/tui/components/StatusLine.tsx` — `statusLineText`/`statusLineParts`, the single
  nested-`<Text>` component.
- `src/tui/viewport.ts` — `wrappedRowCount`, `displayWidth`, `estimateEntryRows`,
  `shiftWindowEnd`, `truncateRowsWithNotice`, `truncateTextToRows`.
- `src/tui/popupWindow.ts` — `popupLayout`, `popupLine`, shared by all three popups.
- `src/tui/components/Transcript.tsx` — the one `overflow="hidden"` sibling.
- `tests/tui/fullscreen-popup-overflow.test.tsx` — `expectEveryFrameSound`, asserted over
  every captured frame; the primary regression coverage for frame-corruption detection
  (see "Row-count assertions cannot detect this class of bug" above).
- `tests/tui/app-scroll.test.tsx`, `tests/tui/viewport.test.ts`,
  `tests/tui/popup-window.test.ts` — further regression coverage for the budget and the
  scroll math.
