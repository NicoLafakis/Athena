// src/tui/components/SessionPicker.tsx
import { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import type { SessionInfo } from '../../harness/sessions.js'

export interface SessionPickerProps {
  sessions: SessionInfo[]
  onSelect: (session: SessionInfo) => void
  onCancel: () => void
}

/** Minimal up/down/enter picker rendered before mounting the main App for `athena --resume`. */
export function SessionPicker({ sessions, onSelect, onCancel }: SessionPickerProps) {
  const [index, setIndex] = useState(0)

  useInput((_ch, key) => {
    if (key.upArrow) setIndex((i) => Math.max(0, i - 1))
    else if (key.downArrow) setIndex((i) => Math.min(sessions.length - 1, i + 1))
    else if (key.return) onSelect(sessions[index]!)
    else if (key.escape) onCancel()
  })

  return (
    <Box flexDirection="column">
      <Text bold>Resume a session (↑/↓, Enter to select, Esc for a new session)</Text>
      {sessions.map((s, i) => (
        <Text key={s.id} color={i === index ? 'cyan' : undefined} inverse={i === index}>
          {s.updatedAt.toISOString().slice(0, 16).replace('T', ' ')} {s.title}
        </Text>
      ))}
    </Box>
  )
}
