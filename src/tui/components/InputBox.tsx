// src/tui/components/InputBox.tsx
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Box, Text, useInput } from 'ink'
import { MentionPopup } from './MentionPopup.js'
import { SlashMenuPopup } from './SlashMenuPopup.js'
import {
  extractMentionBlocks,
  readMentionFile,
  walkMentionFiles,
  type MentionFileContent,
} from '../fileMention.js'
import {
  extractAgentMentionBlocks,
  rankMentionCandidates,
  type AgentMentionSource,
  type MentionCandidate,
} from '../agentMention.js'
import { buildSlashCatalog, filterSlashCommands } from '../slashMenu.js'
import { popupLayout } from '../popupWindow.js'
import { PICKABLE_KINDS } from '../argPicker.js'
import type { CustomCommandDef } from '../slash.js'
import {
  clampCursor,
  cursorRowCol,
  deleteBackward,
  deleteForward,
  deleteWordBackward,
  insertAt,
  isWordBackspaceKey,
  lineEnd,
  lineStart,
  nextWordBoundary,
  prevWordBoundary,
} from '../cursor.js'

/** Tracks an in-progress @-mention: `start` is the index of the triggering '@' inside
 *  `value`, so the filter query is always derived as value.slice(start + 1) rather
 *  than duplicated into its own bit of state that could drift out of sync. */
interface MentionState {
  start: number
  index: number
}

/** Tracks an in-progress live "/" command menu. Unlike MentionState there's no
 *  `start` to track: a slash menu can only ever begin at position 0 (see
 *  beginSlashComposition below), so `index` (the highlighted row) is all the state
 *  that's needed — the filter query is always `value.slice(1)`. */
interface SlashMenuState {
  index: number
}

/** Applies a run of plain typed/pasted characters against the current value/mention
 *  state, one character at a time. This matters because Ink delivers more than one
 *  character per event whenever input arrives faster than it's read — not just on an
 *  explicit clipboard paste, but on any burst of fast typing — and a naive `ch === '@'`
 *  check would silently miss a '@' that arrives bundled with the characters after it
 *  (e.g. a single event carrying "@foo"). Exported for direct unit testing without
 *  rendering anything. */
export function applyTypedChars(
  value: string,
  mention: MentionState | null,
  chars: string,
  cursor: number = value.length,
): { value: string; mention: MentionState | null; cursor: number } {
  const at = clampCursor(value, cursor)
  let head = value.slice(0, at)
  const tail = value.slice(at)
  let m = mention
  for (const c of chars) {
    if (m) {
      if (c === ' ') {
        // Whitespace ends the query per spec; the '@word' typed so far is kept as
        // ordinary text rather than swallowed.
        head += c
        m = null
      } else {
        head += c
        m = { ...m, index: 0 } // filter narrowed: re-anchor highlight to top
      }
    } else if (c === '@' && tail === '') {
      // A '@' only arms mention mode when it's typed at the END of the buffer. Both the
      // query (value.slice(start + 1)) and the popup's own accept/backspace handling
      // assume everything after `start` belongs to the mention — typing '@' in the middle
      // of existing text would make that assumption silently false and swallow the rest
      // of the line into the filter. Cursor motion likewise dismisses the popup (see the
      // motion block in the input handler below), so an armed mention always has its
      // cursor at the end.
      head += c
      m = { start: head.length - 1, index: 0 }
    } else {
      head += c
    }
  }
  return { value: head + tail, mention: m, cursor: head.length }
}

/** Burst-safe counterpart of applyTypedChars for the live "/" menu: simulates a run of
 *  characters arriving in a single Ink input event, keystroke by keystroke, starting
 *  from an empty box whose very first character is '/' (the only position a slash menu
 *  is ever allowed to arm from — see the requirement that '/' NOT as the first
 *  character must never trigger it). Composition ends at the first whitespace
 *  character in the run (mirroring applyTypedChars' space-ends-mention rule); anything
 *  from that whitespace onward is handed back as `rest` so the caller can replay it
 *  through the normal (mention-aware) typing path — e.g. a pasted "/tui fullscreen"
 *  closes the slash menu at the space and types " fullscreen" as ordinary text. */
export function beginSlashComposition(chars: string): { value: string; slash: SlashMenuState | null; rest: string } {
  const afterSlash = chars.slice(1)
  const wsIndex = afterSlash.search(/\s/)
  if (wsIndex === -1) return { value: chars, slash: { index: 0 }, rest: '' }
  const boundary = wsIndex + 1 // index within `chars` of the whitespace character
  return { value: chars.slice(0, boundary), slash: { index: 0 }, rest: chars.slice(boundary) }
}

export interface InputBoxProps {
  onSubmit: (text: string) => void
  disabled: boolean
  /** Project root the @-mention file walk runs from — same coordinate system the
   *  tools resolve file_path against. */
  cwd: string
  /** Directory-backed + plugin custom commands (App's own `commands` prop, threaded
   *  straight through) — unioned with the built-ins to populate the live "/" menu.
   *  Optional so existing callers/tests that don't wire any stay unaffected. */
  commands?: ReadonlyMap<string, CustomCommandDef>
  /** Invocable agents (AgentOrchestrator.listDefs(), threaded through from App the
   *  same way `commands` is — see cli.ts) — unioned with project files to populate
   *  the combined '@' picker. Optional so existing callers/tests that don't wire any
   *  stay unaffected. */
  agents?: readonly AgentMentionSource[]
  /** Terminal column count, threaded down to the popups so each of their rows can be held
   *  to exactly one row (popupWindow.ts's popupLine). Defaults to 80, matching Banner's
   *  and TodoPanel's own defaults. */
  columns?: number
  /** Total rows this component (text lines + open popup) may occupy, from App's fullscreen
   *  row budget. An open popup is clamped to whatever is left after the text lines, and
   *  steps aside entirely when even a one-item popup wouldn't fit — showing fewer
   *  candidates is correct; overflowing an unclipped sibling corrupts the frame. Undefined
   *  in classic mode (unbounded, exactly as before — native scrollback makes fixed-height
   *  layout a non-issue there). */
  maxRows?: number
}

/** What the input box will actually draw this render, and — critically — exactly how tall
 *  it will be, both derived in ONE pass so a caller can budget the rest of the screen
 *  around the very same numbers this render commits to.
 *
 *  This is a hook rather than the `onHeightChange` callback prop it replaces because a
 *  callback can only ever report the height AFTER the commit that already rendered (and
 *  wrote to the terminal) at that height — one full frame late. That lag was harmless
 *  while the box only ever grew a single text row per keystroke, but an overlay popup
 *  opens in one keystroke and jumps the height by ~12 rows, and for that one committed
 *  frame every sibling budgeted from the reported height (TodoPanel, ArgPickerPopup, the
 *  Transcript window) was still sized for the OLD height. In fullscreen mode's fixed
 *  height={rows} column that is not a clipped frame, it is a corrupted one: Yoga shrinks
 *  the oversized siblings and Ink then overwrites/interleaves their lines — dropped todos,
 *  a popup title fused into its first item, the input line drawn over the popup's border —
 *  all while the frame's ROW COUNT still reads exactly `rows`, which is why no row-count
 *  assertion ever caught it. Deriving the height in the same render that consumes it makes
 *  the stale window not smaller but nonexistent.
 *
 *  The anti-oscillation property is unchanged and still structural: `maxRows` (the ceiling
 *  handed IN) must not be derived from any of the panels budgeted OUT of `rows`, or the
 *  loop "popup opens -> panel shrinks -> more room -> popup grows" replaces the lag with a
 *  non-settling layout. See App.tsx's inputMaxRows. */
export function useInputBox({
  onSubmit,
  disabled,
  cwd,
  commands,
  agents,
  columns = 80,
  maxRows,
}: InputBoxProps): { rows: number; element: ReactElement } {
  const [value, setValue] = useState('')
  // Flat index into `value` (0..value.length) marking the insertion point. A single index,
  // NOT a [row, col] pair — `value` can contain '\n' via backslash-continuation, and
  // multi-line behavior is expressed by respecting those '\n' boundaries inside this flat
  // index (see ../cursor.ts). Every mutation path below moves it explicitly; nothing may
  // assume it sits at value.length any more.
  const [cursor, setCursor] = useState(0)
  const [history, setHistory] = useState<string[]>([])
  // historyIndex === history.length means "editing a fresh line"
  const [historyIndex, setHistoryIndex] = useState(0)
  const [draft, setDraft] = useState('')

  const [mention, setMention] = useState<MentionState | null>(null)
  const [allFiles, setAllFiles] = useState<string[] | null>(null)
  const [slashMenu, setSlashMenu] = useState<SlashMenuState | null>(null)
  // Stable across the session (App threads the same Map down every render) — memoized
  // so a busy App re-rendering on every streamed event doesn't rebuild the array.
  const slashCatalog = useMemo(() => buildSlashCatalog(commands), [commands])
  // Every file selected via @-mention this turn, keyed by relative path — read once,
  // reused if the same file is mentioned again before the turn is submitted. A ref
  // because populating it must never itself trigger a re-render.
  const mentionedFiles = useRef<Map<string, MentionFileContent>>(new Map())

  // One-time (per cwd) recursive file walk, kept warm for the life of the input box
  // rather than re-walked on every '@' — see src/tui/fileMention.ts.
  useEffect(() => {
    let live = true
    walkMentionFiles(cwd)
      .then((files) => {
        if (live) setAllFiles(files)
      })
      .catch(() => {
        /* best-effort: the popup just stays in its "indexing" state if the walk fails */
      })
    return () => {
      live = false
    }
  }, [cwd])

  const query = mention ? value.slice(mention.start + 1) : ''
  // Combined files+agents ranking (agentMention.ts): agent matches are already
  // available synchronously (no walk to wait on), so they can appear even before
  // `allFiles` resolves — only the file half of the list waits on the walk.
  const matches = mention ? rankMentionCandidates(query, allFiles ?? [], agents ?? []) : []

  const slashQuery = slashMenu ? value.slice(1) : ''
  const slashMatches = slashMenu ? filterSlashCommands(slashCatalog, slashQuery) : []

  /** The single seam every buffer mutation goes through, so value and cursor can never be
   *  updated independently and drift apart (the cursor is clamped against the NEW text,
   *  not the old one). */
  function setBuffer(next: { value: string; cursor: number }): void {
    setValue(next.value)
    setCursor(clampCursor(next.value, next.cursor))
  }

  function selectMention(candidate: MentionCandidate): void {
    if (!mention) return
    const before = value.slice(0, mention.start)
    // Cursor lands just past the inserted token's trailing space, ready to keep typing.
    const inserted = `${before}@${candidate.value} `
    setBuffer({ value: inserted, cursor: inserted.length })
    setMention(null)
    // Only file rows have content to cache — agent guidance is re-derived fresh from
    // the `agents` prop at submit time (extractAgentMentionBlocks), no caching needed.
    if (candidate.kind === 'file' && !mentionedFiles.current.has(candidate.value)) {
      mentionedFiles.current.set(candidate.value, readMentionFile(cwd, candidate.value))
    }
  }

  useInput(
    (ch, key) => {
      // --- Cursor motion and word-wise editing. Claimed FIRST, ahead of both sub-modes
      // below AND ahead of all three `if (key.ctrl || key.meta …) return` short-circuits
      // that used to swallow every modifier combo before any handler could see it. One
      // block rather than three copies: the bindings are identical in every mode, and the
      // sub-modes' own short-circuits still guard whatever this block doesn't claim.
      //
      // Any motion or word-delete DISMISSES an open @-mention / "/" popup. Both derive
      // their query from a value the cursor is assumed to sit at the end of
      // (value.slice(mention.start + 1) and value.slice(1) respectively), so editing away
      // from the end would leave the popup filtering on text that is no longer there.
      // Dismissing keeps the typed characters as ordinary literal text, exactly like Esc
      // already does, and keeps every in-mode edit path below at cursor === value.length.
      //
      // Encoding note (Windows Terminal + PowerShell is the primary host): Ink's vendored
      // parser reads modified arrows as xterm CSI (`\x1b[1;5D` -> leftArrow + ctrl,
      // `\x1b[1;3D` -> leftArrow + meta). Hosts that instead emit the readline-style
      // ESC-prefixed `\x1b b` / `\x1b f` arrive as meta + input 'b'/'f', handled below as
      // an alias. Anything else the parser doesn't recognize yields an empty `input` and
      // no matching key flag, so it falls through every branch and does nothing at all —
      // never inserting stray escape bytes into the buffer.
      const dismissPopups = (): void => {
        setMention(null)
        setSlashMenu(null)
      }
      if (key.leftArrow || key.rightArrow) {
        const byWord = key.ctrl || key.meta
        const next = key.leftArrow
          ? byWord
            ? prevWordBoundary(value, cursor)
            : Math.max(0, cursor - 1)
          : byWord
            ? nextWordBoundary(value, cursor)
            : Math.min(value.length, cursor + 1)
        dismissPopups()
        setCursor(next)
        return
      }
      if (key.meta && !key.ctrl && (ch === 'b' || ch === 'f')) {
        dismissPopups()
        setCursor(ch === 'b' ? prevWordBoundary(value, cursor) : nextWordBoundary(value, cursor))
        return
      }
      if (key.ctrl && (ch === 'a' || ch === 'e')) {
        // Line-wise, not buffer-wise: '\n' boundaries are respected so these behave the
        // way they do in any shell once backslash-continuation has made the input
        // multi-line.
        dismissPopups()
        setCursor(ch === 'a' ? lineStart(value, cursor) : lineEnd(value, cursor))
        return
      }
      if ((key.ctrl && ch === 'w') || isWordBackspaceKey(key)) {
        dismissPopups()
        setBuffer(deleteWordBackward(value, cursor))
        return
      }
      if (key.ctrl && ch === 'd') {
        // Forward-delete's readline binding. The Delete key itself is NOT bindable here:
        // Ink's parser names both `\x7f` (plain Backspace on most hosts) and `\x1b[3~`
        // (the real Delete key) 'delete', and blanks `input` for both, so honoring Delete
        // as a forward delete would silently turn every Backspace into one.
        dismissPopups()
        setBuffer(deleteForward(value, cursor))
        return
      }

      // --- @-mention mode: intercepts navigation before any normal-mode handling
      // below (in particular, Enter here selects instead of submitting). ---
      if (mention) {
        if (key.escape) {
          setMention(null) // typed '@query' stays as plain literal text
          return
        }
        if (key.upArrow) {
          setMention({ ...mention, index: Math.max(0, mention.index - 1) })
          return
        }
        if (key.downArrow) {
          const maxIndex = Math.max(matches.length - 1, 0)
          setMention({ ...mention, index: Math.min(maxIndex, mention.index + 1) })
          return
        }
        if (key.tab || key.return) {
          const picked = matches[mention.index]
          if (picked) selectMention(picked)
          else setMention(null) // nothing under the cursor: close, keep typed text
          return
        }
        if (key.backspace || key.delete) {
          // An armed mention always has its cursor at the end (motion dismisses it), so
          // this is the same single-character delete it always was — just routed through
          // the cursor-aware helper rather than assuming the end.
          const edit = deleteBackward(value, cursor)
          const next = edit.value
          setBuffer(edit)
          if (next.length <= mention.start) {
            setMention(null) // deleted the '@' itself
          } else {
            // Filter widened: re-anchor highlight to top, symmetric with the narrowing
            // case in applyTypedChars — otherwise `index` can keep pointing past the end
            // of a `matches` array that just grew back.
            setMention({ ...mention, index: 0 })
          }
          return
        }
        if (key.ctrl || key.meta) return
        if (ch) {
          const result = applyTypedChars(value, mention, ch, cursor)
          setBuffer(result)
          setMention(result.mention)
        }
        return
      }

      // --- live "/" command menu: same precedence discipline as @-mention above (this
      // branch never runs while `mention` is truthy, and vice versa — the two modes
      // are armed mutually exclusively, see beginSlashComposition/the typing branch
      // below). Enter/Tab select; the one deliberate exception is a Return on an
      // already-exact, unambiguous command name, which passes through to the ordinary
      // submit path below instead of "selecting" a no-op completion of itself — see
      // the report for why (keeps a fully-typed built-in like /compact submitting on a
      // single Enter, matching pre-existing behavior/tests). ---
      if (slashMenu) {
        if (key.escape) {
          setSlashMenu(null) // typed '/query' stays as plain literal text
          return
        }
        if (key.upArrow) {
          setSlashMenu({ index: Math.max(0, slashMenu.index - 1) })
          return
        }
        if (key.downArrow) {
          const maxIndex = Math.max(slashMatches.length - 1, 0)
          setSlashMenu({ index: Math.min(maxIndex, slashMenu.index + 1) })
          return
        }
        if (key.tab || key.return) {
          const typedName = value.slice(1)
          // A fully-typed, EXACT command name always wins over whatever the cursor
          // happens to be sitting on. Without this, prefix collisions between two
          // catalog entries (e.g. "mode" is a strict prefix of "model") would let the
          // catalog's index-0 entry silently shadow the one the user actually typed,
          // since slashMenu.index resets to 0 on every narrowing keystroke and is never
          // touched unless the user explicitly presses an arrow key. Cursor-index
          // selection should only govern genuinely ambiguous *partial* typing (e.g.
          // "/mo"), where no entry is an exact match yet.
          const exactMatch = slashMatches.find((m) => m.name === typedName)
          const picked = exactMatch ?? slashMatches[slashMenu.index]
          const nothingLeftToComplete = key.return && !!exactMatch
          if (picked && PICKABLE_KINDS.has(picked.name) && (key.tab || nothingLeftToComplete)) {
            // A pickable command (/model /provider /effort /mode /tui) with nothing left
            // to type opens App's second-level value picker instead of waiting for an
            // argument — hand off through the exact same onSubmit path a manually-typed
            // "/model" + Enter takes, rather than duplicating picker-opening logic here
            // (App.tsx owns detectBarePickableCommand and the picker itself).
            setHistory((prev) => [...prev, `/${picked.name}`])
            setHistoryIndex(history.length + 1)
            setBuffer({ value: '', cursor: 0 })
            setSlashMenu(null)
            onSubmit(`/${picked.name}`)
            return
          }
          if (nothingLeftToComplete) {
            setSlashMenu(null) // fall through to the shared Enter-submit logic below
          } else if (picked) {
            // Cursor lands after the completed name's trailing space, ready for an argument.
            const completed = `/${picked.name} `
            setBuffer({ value: completed, cursor: completed.length })
            setSlashMenu(null)
            return
          } else {
            setSlashMenu(null) // nothing under the cursor: close, keep typed text
            return
          }
        } else if (key.backspace || key.delete) {
          // Cursor is always at the end while the menu is armed (motion dismisses it).
          const edit = deleteBackward(value, cursor)
          setBuffer(edit)
          if (edit.value.length === 0) setSlashMenu(null) // deleted the '/' itself
          return
        } else if (key.ctrl || key.meta) {
          return
        } else if (ch) {
          setBuffer(insertAt(value, cursor, ch))
          if (/\s/.test(ch)) {
            // Whitespace ends composition per spec; the '/word' typed so far is kept
            // as ordinary text rather than swallowed.
            setSlashMenu(null)
          } else {
            setSlashMenu({ index: 0 }) // filter narrowed: re-anchor highlight to top
          }
          return
        } else {
          return
        }
      }

      if (key.return) {
        if (value.endsWith('\\')) {
          // Backslash continuation: strip the backslash, insert a newline. Stays anchored
          // to the END of the buffer (that's where the trailing backslash is by
          // definition), and the cursor follows onto the new line.
          const continued = `${value.slice(0, -1)}\n`
          setBuffer({ value: continued, cursor: continued.length })
          return
        }
        const text = value
        if (text.trim() === '') return
        setHistory((prev) => [...prev, text])
        setHistoryIndex(history.length + 1)
        // Splice in context blocks for every @mention still literally present in the
        // submitted text — history recall or a backspaced-away mention must not drag
        // a stale file's content (fileMention.ts: extractMentionBlocks) or a removed
        // agent's guidance (agentMention.ts: extractAgentMentionBlocks) along. Additive:
        // a single message can carry both kinds, each producing its own labeled block.
        const blocks = [
          ...extractMentionBlocks(text, mentionedFiles.current),
          ...extractAgentMentionBlocks(text, agents ?? []),
        ]
        const finalText = blocks.length > 0 ? `${text}\n\n${blocks.join('\n\n')}` : text
        setBuffer({ value: '', cursor: 0 })
        setDraft('')
        mentionedFiles.current = new Map() // next turn re-reads files fresh (they may have changed)
        onSubmit(finalText)
        return
      }
      if (key.backspace || key.delete) {
        setBuffer(deleteBackward(value, cursor))
        return
      }
      if (key.upArrow) {
        if (history.length === 0 || historyIndex === 0) return
        if (historyIndex === history.length) setDraft(value)
        const next = historyIndex - 1
        setHistoryIndex(next)
        // Recalled text arrives ready to be appended to / edited from its end, the way
        // every shell's history recall behaves.
        const recalled = history[next] ?? ''
        setBuffer({ value: recalled, cursor: recalled.length })
        return
      }
      if (key.downArrow) {
        if (historyIndex >= history.length) return
        const next = historyIndex + 1
        setHistoryIndex(next)
        const recalled = next === history.length ? draft : (history[next] ?? '')
        setBuffer({ value: recalled, cursor: recalled.length })
        return
      }
      if (key.ctrl || key.meta || key.escape || key.tab) return
      if (ch) {
        // A bare '/' only ever arms the live menu as the very first character of an
        // empty box (never mid-text) — mirrored here burst-safe via
        // beginSlashComposition for the same reason applyTypedChars simulates '@'
        // char-by-char: fast typing can deliver a whole word in one Ink input event.
        if (value === '' && ch[0] === '/') {
          const begun = beginSlashComposition(ch)
          if (begun.rest) {
            // Composition ended mid-burst (whitespace arrived in the same chunk, e.g.
            // a pasted "/tui fullscreen") — replay the remainder through the normal
            // (mention-aware) typing path so a trailing @mention still arms correctly.
            const after = applyTypedChars(begun.value, null, begun.rest)
            setBuffer(after)
            if (after.mention) setMention(after.mention)
          } else {
            setBuffer({ value: begun.value, cursor: begun.value.length })
            setSlashMenu(begun.slash)
          }
          return
        }
        const result = applyTypedChars(value, null, ch, cursor)
        setBuffer(result)
        if (result.mention) setMention(result.mention)
      }
    },
    { isActive: !disabled },
  )

  const lines = value.split('\n')
  const caret = cursorRowCol(value, cursor)
  // The text lines are non-negotiable (they're what the user is typing into), so the popup
  // gets whatever `maxRows` leaves over rather than the other way round. `null` from
  // popupLayout means "not even one row fits" — the popup then renders nothing and costs
  // nothing, instead of overflowing a sibling nothing clips. mention/slashMenu are armed
  // mutually exclusively (see the two input branches above), but summing both is what
  // makes that a fact about the reported height rather than an assumption baked into it.
  const popupBudget = maxRows === undefined ? undefined : Math.max(maxRows - lines.length, 0)
  const mentionLayout = mention ? popupLayout(matches.length, mention.index, popupBudget) : null
  const slashLayout = slashMenu ? popupLayout(slashMatches.length, slashMenu.index, popupBudget) : null
  // One height number covering everything this hook actually draws — the text lines PLUS
  // whichever popup is open, since MentionPopup/SlashMenuPopup render as siblings inside
  // this same column and are just as unclipped in fullscreen mode's fixed-height layout as
  // the text lines are. mention/slashMenu are armed mutually exclusively (see the two input
  // branches above), but summing both layouts is what makes that a fact about the number
  // rather than an assumption baked into it. Returned alongside the element rather than
  // pushed out through a callback, so the caller has it BEFORE it renders anything sized
  // against it — see the hook's doc comment.
  const totalRows = lines.length + (mentionLayout?.rows ?? 0) + (slashLayout?.rows ?? 0)
  const element = (
    <Box flexDirection="column">
      {mention && mentionLayout && (
        <MentionPopup
          query={query}
          matches={matches}
          index={mention.index}
          loading={!allFiles}
          layout={mentionLayout}
          columns={columns}
        />
      )}
      {slashMenu && slashLayout && (
        <SlashMenuPopup
          query={slashQuery}
          matches={slashMatches}
          index={slashMenu.index}
          layout={slashLayout}
          columns={columns}
        />
      )}
      {lines.map((line, idx) => {
        const prefix = idx === 0 ? '❯ ' : '… '
        // The cursor is drawn as an inverse-video block ON the character it sits at (or on
        // a trailing space when it's past the end of that line), so it's visible wherever
        // in the buffer editing is happening rather than only ever at the end. A disabled
        // box (busy turn / pending dialog / open arg picker) draws none at all, exactly as
        // before. Rendering-only derivation — the cursor itself is never stored as a
        // row/col pair (see ../cursor.ts).
        if (disabled || idx !== caret.row) {
          return (
            <Text key={idx}>
              {prefix}
              {line}
            </Text>
          )
        }
        return (
          <Text key={idx}>
            {prefix}
            {line.slice(0, caret.col)}
            <Text inverse>{line.slice(caret.col, caret.col + 1) || ' '}</Text>
            {line.slice(caret.col + 1)}
          </Text>
        )
      })}
    </Box>
  )
  return { rows: totalRows, element }
}

/** Component form of useInputBox, for callers that don't budget any other sibling against
 *  this box's height and so have no use for the number (classic-mode-shaped usage, and
 *  every focused InputBox test). App.tsx deliberately does NOT go through this wrapper —
 *  it calls the hook directly, because it needs `rows` in the same render that sizes
 *  TodoPanel/ArgPickerPopup/the Transcript window around it. One implementation either
 *  way: this is the hook, minus the number. */
export function InputBox(props: InputBoxProps): ReactElement {
  return useInputBox(props).element
}
