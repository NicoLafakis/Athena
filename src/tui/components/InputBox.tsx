// src/tui/components/InputBox.tsx
import { useEffect, useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { FileMentionPopup } from './FileMentionPopup.js'
import {
  extractMentionBlocks,
  rankFileMatches,
  readMentionFile,
  walkMentionFiles,
  type MentionFileContent,
} from '../fileMention.js'

/** Tracks an in-progress @-mention: `start` is the index of the triggering '@' inside
 *  `value`, so the filter query is always derived as value.slice(start + 1) rather
 *  than duplicated into its own bit of state that could drift out of sync. */
interface MentionState {
  start: number
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

export function InputBox({
  onSubmit,
  disabled,
  cwd,
}: {
  onSubmit: (text: string) => void
  disabled: boolean
  /** Project root the @-mention file walk runs from — same coordinate system the
   *  tools resolve file_path against. */
  cwd: string
}) {
  const [value, setValue] = useState('')
  const [history, setHistory] = useState<string[]>([])
  // historyIndex === history.length means "editing a fresh line"
  const [historyIndex, setHistoryIndex] = useState(0)
  const [draft, setDraft] = useState('')

  const [mention, setMention] = useState<MentionState | null>(null)
  const [allFiles, setAllFiles] = useState<string[] | null>(null)
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
  const matches = mention && allFiles ? rankFileMatches(query, allFiles) : []

  function selectMention(relPath: string): void {
    if (!mention) return
    const before = value.slice(0, mention.start)
    setValue(`${before}@${relPath} `)
    setMention(null)
    if (!mentionedFiles.current.has(relPath)) {
      mentionedFiles.current.set(relPath, readMentionFile(cwd, relPath))
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
          if (next.length <= mention.start) setMention(null) // deleted the '@' itself
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
        // a stale file's content along (src/tui/fileMention.ts: extractMentionBlocks).
        const blocks = extractMentionBlocks(text, mentionedFiles.current)
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
        const result = applyTypedChars(value, null, ch)
        setValue(result.value)
        if (result.mention) setMention(result.mention)
      }
    },
    { isActive: !disabled },
  )

  const lines = value.split('\n')
  return (
    <Box flexDirection="column">
      {mention && <FileMentionPopup query={query} matches={matches} index={mention.index} loading={!allFiles} />}
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
