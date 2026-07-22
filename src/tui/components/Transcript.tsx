// src/tui/components/Transcript.tsx
import { Box, Text } from 'ink'
import { ToolCard } from './ToolCard.js'

export type TranscriptEntry =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'system'; text: string }
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

export function Transcript({ entries }: { entries: TranscriptEntry[] }) {
  return (
    <Box flexDirection="column">
      {entries.map((entry, idx) => {
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
