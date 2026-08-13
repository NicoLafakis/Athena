// src/tui/components/Transcript.tsx
import { Box, Text } from 'ink'
import { ToolCard } from './ToolCard.js'
import {
  estimateEntryRows,
  sliceToAnchor,
  thinkingDisplayText,
  wrapToRows,
  type ScrollAnchor,
} from '../viewport.js'

export type TranscriptEntry =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'system'; text: string; id?: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; id: string; name: string; input: unknown; output: string | null; isError: boolean }

/** Lightweight markdown degradation: bold headings, dim code fences. No external md lib. */
function AssistantText({ text }: { text: string }) {
  const lines = text.split('\n')
  let inFence = false
  return (
    <Box flexDirection="column">
      {lines.map((line, idx) => {
        if (line.trimStart().startsWith('```')) {
          inFence = !inFence
          return (
            <Text key={idx} dimColor>
              {line}
            </Text>
          )
        }
        if (inFence)
          return (
            <Text key={idx} dimColor>
              {line}
            </Text>
          )
        if (/^#{1,6}\s/.test(line))
          return (
            <Text key={idx} bold>
              {line.replace(/^#{1,6}\s/, '')}
            </Text>
          )
        return <Text key={idx}>{line}</Text>
      })}
    </Box>
  )
}

export function Transcript({
  entries,
  maxRows,
  anchor,
  columns,
}: {
  entries: TranscriptEntry[]
  /** Fullscreen-mode viewport bound, in terminal rows. Classic mode omits this and
   *  renders the full history unchanged — native scrollback handles it. When set, only
   *  the window of rows addressed by `anchor` is rendered, keeping render/memory cost
   *  flat regardless of session length (see ../viewport.ts). */
  maxRows?: number
  /** Scroll position (see App.tsx's scrollAnchor state). Null/omitted means "pinned to
   *  the live tail", which is the pre-scrolling behavior. Only meaningful alongside
   *  maxRows: classic mode renders everything regardless. */
  anchor?: ScrollAnchor | null
  /** Current terminal width, so the row estimate that picks the window is measured
   *  against the width the content actually wraps at rather than viewport.ts's 80-column
   *  default. Omitted in classic mode (nothing is estimated there). */
  columns?: number
}) {
  const width = Math.max(columns ?? 80, 1)
  const rowsOf = (entry: TranscriptEntry): number => estimateEntryRows(entry, columns)
  const window =
    maxRows === undefined
      ? { items: entries, clipFirstRows: 0, clipLastRows: 0 }
      : sliceToAnchor(entries, rowsOf, maxRows, anchor ?? null, (entry) => entry.kind !== 'tool')
  /** Row-precise clipping for text kinds, measured with the same wrap math the
   *  estimator uses (wrapToRows), so a clipped entry renders exactly the rows the
   *  window budgeted for it. */
  const clipText = (text: string, dropFirst: number, dropLast: number): string => {
    if (dropFirst <= 0 && dropLast <= 0) return text
    const rows = wrapToRows(text, width)
    const end = dropLast > 0 ? Math.max(rows.length - dropLast, dropFirst) : rows.length
    return rows.slice(dropFirst, end).join('\n')
  }
  return (
    <Box flexDirection="column">
      {window.items.map((entry, idx) => {
        const dropFirst = idx === 0 ? window.clipFirstRows : 0
        const dropLast = idx === window.items.length - 1 ? window.clipLastRows : 0
        switch (entry.kind) {
          case 'user':
            return (
              <Text key={idx} color="cyan">
                {'> '}
                {clipText(entry.text, dropFirst, dropLast)}
              </Text>
            )
          case 'assistant':
            return <AssistantText key={idx} text={clipText(entry.text, dropFirst, dropLast)} />
          case 'system':
            return (
              <Text key={idx} dimColor italic>
                {clipText(entry.text, dropFirst, dropLast)}
              </Text>
            )
          case 'thinking':
            // thinkingDisplayText owns the `· ` prefix and the tail cap; the row
            // estimator measures this same string, so height and budget always agree.
            return (
              <Text key={idx} dimColor italic>
                {clipText(thinkingDisplayText(entry.text, width), dropFirst, dropLast)}
              </Text>
            )
          case 'tool':
            return (
              <ToolCard
                key={entry.id}
                name={entry.name}
                input={entry.input}
                output={entry.output}
                isError={entry.isError}
              />
            )
        }
      })}
    </Box>
  )
}
