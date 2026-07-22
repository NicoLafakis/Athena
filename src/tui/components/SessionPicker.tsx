// src/tui/components/SessionPicker.tsx
import { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import type { SessionInfo } from '../../harness/sessions.js'

export interface SessionPickerProps {
  sessions: SessionInfo[]
  onSelect: (session: SessionInfo) => void
  onCancel: () => void
}

const WINDOW = 10

/** Minimal up/down/enter picker rendered before mounting the main App for `athena --resume`. */
export function SessionPicker({ sessions, onSelect, onCancel }: SessionPickerProps) {
  const [index, setIndex] = useState(0)

  useInput((_ch, key) => {
    if (sessions.length === 0) {
      // Nothing to select: any confirm/cancel key falls through to a fresh session.
      if (key.return || key.escape) onCancel()
      return
    }
    if (key.upArrow) setIndex((i) => Math.max(0, i - 1))
    else if (key.downArrow) setIndex((i) => Math.min(sessions.length - 1, i + 1))
    else if (key.return) {
      const picked = sessions[index]
      if (picked) onSelect(picked)
    } else if (key.escape) onCancel()
  })

  if (sessions.length === 0) {
    return <Text dimColor>No past sessions for this project — press Enter for a new session.</Text>
  }

  // Windowed render: keep the selection visible without drawing an unbounded list.
  const start = Math.min(Math.max(0, index - WINDOW + 1), Math.max(0, sessions.length - WINDOW))
  const visible = sessions.slice(start, start + WINDOW)
  return (
    <Box flexDirection="column">
      <Text bold>Resume a session (↑/↓, Enter to select, Esc for a new session)</Text>
      {start > 0 && <Text dimColor>… {start} earlier</Text>}
      {visible.map((s, i) => {
        const abs = start + i
        return (
          <Text key={s.id} color={abs === index ? 'cyan' : undefined} inverse={abs === index}>
            {s.updatedAt.toISOString().slice(0, 16).replace('T', ' ')} {s.title}
          </Text>
        )
      })}
      {start + WINDOW < sessions.length && (
        <Text dimColor>… {sessions.length - start - WINDOW} more</Text>
      )}
    </Box>
  )
}
