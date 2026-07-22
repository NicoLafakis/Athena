// src/tui/components/InputBox.tsx
import { useState } from 'react'
import { Box, Text, useInput } from 'ink'

export function InputBox({
  onSubmit,
  disabled,
}: {
  onSubmit: (text: string) => void
  disabled: boolean
}) {
  const [value, setValue] = useState('')
  const [history, setHistory] = useState<string[]>([])
  // historyIndex === history.length means "editing a fresh line"
  const [historyIndex, setHistoryIndex] = useState(0)
  const [draft, setDraft] = useState('')

  useInput(
    (ch, key) => {
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
        setValue('')
        setDraft('')
        onSubmit(text)
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
      if (ch) setValue((v) => v + ch)
    },
    { isActive: !disabled },
  )

  const lines = value.split('\n')
  return (
    <Box flexDirection="column">
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
