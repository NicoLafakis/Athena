// src/tui/components/ToolCard.tsx
import { Box, Text } from 'ink'
import { DiffPreview } from './DiffPreview.js'
import { toolDisplayText } from '../tool-display.js'

function isWriteOrEdit(name: string, input: unknown): input is Record<string, unknown> {
  return (name === 'Write' || name === 'Edit') && typeof input === 'object' && input !== null
}

export function ToolCard({
  name,
  input,
  output,
  isError,
  expanded,
  completed,
}: {
  name: string
  input: unknown
  output: string | null
  isError: boolean
  expanded?: boolean
  completed?: boolean
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
  return <Text color={isError ? 'red' : 'green'}>{toolDisplayText({ name, input, output, isError, completed })}</Text>
}
