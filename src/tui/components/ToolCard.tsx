// src/tui/components/ToolCard.tsx
import { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import { DiffPreview } from './DiffPreview.js'

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function Spinner() {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80)
    return () => clearInterval(timer)
  }, [])
  return <Text color="yellow">{SPINNER_FRAMES[frame]}</Text>
}

function inputSummary(input: unknown): string {
  if (input === null || input === undefined) return ''
  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>
    const first =
      obj['command'] ?? obj['file_path'] ?? obj['pattern'] ?? obj['url'] ?? obj['query'] ?? ''
    const s = typeof first === 'string' ? first : JSON.stringify(input)
    return s.length > 60 ? `${s.slice(0, 57)}...` : s
  }
  const s = String(input)
  return s.length > 60 ? `${s.slice(0, 57)}...` : s
}

function isWriteOrEdit(name: string, input: unknown): input is Record<string, unknown> {
  return (name === 'Write' || name === 'Edit') && typeof input === 'object' && input !== null
}

export function ToolCard({
  name,
  input,
  output,
  isError,
  expanded,
}: {
  name: string
  input: unknown
  output: string | null
  isError: boolean
  expanded?: boolean
}) {
  if (expanded) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={isError ? 'red' : 'green'} paddingX={1}>
        <Text bold color={isError ? 'red' : 'green'}>
          ⚙ {name}
        </Text>
        {isWriteOrEdit(name, input) ? (
          <DiffPreview
            oldText={String(input['old_string'] ?? '')}
            newText={String(input['new_string'] ?? input['content'] ?? '')}
          />
        ) : (
          <Text dimColor>{JSON.stringify(input, null, 2)}</Text>
        )}
        {output !== null && <Text>{output}</Text>}
      </Box>
    )
  }
  const firstLine = output === null ? '' : (output.split('\n')[0] ?? '')
  return (
    <Box>
      <Text color={isError ? 'red' : 'green'}>
        ⚙ {name}({inputSummary(input)})
      </Text>
      {output === null ? (
        <>
          <Text> </Text>
          <Spinner />
        </>
      ) : (
        <Text dimColor> → {firstLine}</Text>
      )}
    </Box>
  )
}
