// src/tui/components/InputBox.tsx
import { useEffect, useMemo, useRef, useState } from 'react'
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
import { PICKABLE_KINDS } from '../argPicker.js'
import type { CustomCommandDef } from '../slash.js'

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
): { value: string; mention: MentionState | null } {
  let v = value
  let m = mention
  for (const c of chars) {
    if (m) {
      if (c === ' ') {
        // Whitespace ends the query per spec; the '@word' typed so far is kept as
        // ordinary text rather than swallowed.
        v += c
        m = null
      } else {
        v += c
        m = { ...m, index: 0 } // filter narrowed: re-anchor highlight to top
      }
    } else if (c === '@') {
      v += c
      m = { start: v.length - 1, index: 0 }
    } else {
      v += c
    }
  }
  return { value: v, mention: m }
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

export function InputBox({
  onSubmit,
  disabled,
  cwd,
  commands,
  agents,
  onHeightChange,
}: {
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
  /** Reports the box's actual current row count (`value.split('\n').length`, so it grows
   *  with backslash-continuation) on every change, so callers that budget remaining
   *  terminal rows around this component (fullscreen App's PermissionDialog/TodoPanel
   *  sizing) react to it instead of assuming a fixed 1-row height. Optional so existing
   *  callers/tests that don't wire any stay unaffected. */
  onHeightChange?: (rows: number) => void
}) {
  const [value, setValue] = useState('')
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

  function selectMention(candidate: MentionCandidate): void {
    if (!mention) return
    const before = value.slice(0, mention.start)
    setValue(`${before}@${candidate.value} `)
    setMention(null)
    // Only file rows have content to cache — agent guidance is re-derived fresh from
    // the `agents` prop at submit time (extractAgentMentionBlocks), no caching needed.
    if (candidate.kind === 'file' && !mentionedFiles.current.has(candidate.value)) {
      mentionedFiles.current.set(candidate.value, readMentionFile(cwd, candidate.value))
    }
  }

  useInput(
    (ch, key) => {
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
          const next = value.slice(0, -1)
          setValue(next)
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
          const result = applyTypedChars(value, mention, ch)
          setValue(result.value)
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
            setValue('')
            setSlashMenu(null)
            onSubmit(`/${picked.name}`)
            return
          }
          if (nothingLeftToComplete) {
            setSlashMenu(null) // fall through to the shared Enter-submit logic below
          } else if (picked) {
            setValue(`/${picked.name} `)
            setSlashMenu(null)
            return
          } else {
            setSlashMenu(null) // nothing under the cursor: close, keep typed text
            return
          }
        } else if (key.backspace || key.delete) {
          const next = value.slice(0, -1)
          setValue(next)
          if (next.length === 0) setSlashMenu(null) // deleted the '/' itself
          return
        } else if (key.ctrl || key.meta) {
          return
        } else if (ch) {
          if (/\s/.test(ch)) {
            // Whitespace ends composition per spec; the '/word' typed so far is kept
            // as ordinary text rather than swallowed.
            setValue(value + ch)
            setSlashMenu(null)
          } else {
            setValue(value + ch)
            setSlashMenu({ index: 0 }) // filter narrowed: re-anchor highlight to top
          }
          return
        } else {
          return
        }
      }

      if (key.return) {
        if (value.endsWith('\\')) {
          // Backslash continuation: strip the backslash, insert a newline.
          setValue(value.slice(0, -1) + '\n')
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
        setValue('')
        setDraft('')
        mentionedFiles.current = new Map() // next turn re-reads files fresh (they may have changed)
        onSubmit(finalText)
        return
      }
      if (key.backspace || key.delete) {
        setValue((v) => v.slice(0, -1))
        return
      }
      if (key.upArrow) {
        if (history.length === 0 || historyIndex === 0) return
        if (historyIndex === history.length) setDraft(value)
        const next = historyIndex - 1
        setHistoryIndex(next)
        setValue(history[next] ?? '')
        return
      }
      if (key.downArrow) {
        if (historyIndex >= history.length) return
        const next = historyIndex + 1
        setHistoryIndex(next)
        setValue(next === history.length ? draft : (history[next] ?? ''))
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
            setValue(after.value)
            if (after.mention) setMention(after.mention)
          } else {
            setValue(begun.value)
            setSlashMenu(begun.slash)
          }
          return
        }
        const result = applyTypedChars(value, null, ch)
        setValue(result.value)
        if (result.mention) setMention(result.mention)
      }
    },
    { isActive: !disabled },
  )

  const lines = value.split('\n')
  useEffect(() => {
    onHeightChange?.(lines.length)
  }, [lines.length, onHeightChange])
  return (
    <Box flexDirection="column">
      {mention && <MentionPopup query={query} matches={matches} index={mention.index} loading={!allFiles} />}
      {slashMenu && <SlashMenuPopup query={slashQuery} matches={slashMatches} index={slashMenu.index} />}
      {lines.map((line, idx) => (
        <Text key={idx}>
          {idx === 0 ? '❯ ' : '… '}
          {line}
          {idx === lines.length - 1 && !disabled ? <Text inverse> </Text> : null}
        </Text>
      ))}
    </Box>
  )
}
