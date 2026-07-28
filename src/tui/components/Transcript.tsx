// src/tui/components/Transcript.tsx
import { Box, Text } from 'ink'
import { ToolCard } from './ToolCard.js'
import { estimateEntryRows, sliceToRows } from '../viewport.js'

export type TranscriptEntry =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'system'; text: string; id?: string }
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
  windowEnd,
  columns,
}: {
  entries: TranscriptEntry[]
  /** Fullscreen-mode viewport bound, in terminal rows. Classic mode omits this and
   *  renders the full history unchanged — native scrollback handles it. When set, only
   *  the most recent entries that fit are rendered, keeping render/memory cost flat
   *  regardless of session length (see ../viewport.ts). */
  maxRows?: number
  /** Exclusive index of the last entry the window ends at — the scroll position (see
   *  App.tsx's scrollEnd state). Omitted/undefined means "pinned to the live tail",
   *  which is the pre-scrolling behavior. Only meaningful alongside maxRows: classic
   *  mode renders everything regardless. */
  windowEnd?: number
  /** Current terminal width, so the row estimate that picks the window is measured
   *  against the width the content actually wraps at rather than viewport.ts's 80-column
   *  default. Omitted in classic mode (nothing is estimated there). */
  columns?: number
}) {
  const rowsOf = (entry: TranscriptEntry): number => estimateEntryRows(entry, columns)
  const visible =
    maxRows === undefined ? entries : sliceToRows(entries, rowsOf, maxRows, windowEnd ?? entries.length)
  return (
    <Box flexDirection="column">
      {visible.map((entry, idx) => {
        switch (entry.kind) {
          case 'user':
            return (
              <Text key={idx} color="cyan">
                {'> '}
                {entry.text}
              </Text>
            )
          case 'assistant':
            return <AssistantText key={idx} text={entry.text} />
          case 'system':
            return (
              <Text key={idx} dimColor italic>
                {entry.text}
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
