// src/tui/components/SlashMenuPopup.tsx
import { Box, Text } from 'ink'
import type { SlashMenuEntry } from '../slashMenu.js'

const WINDOW = 8

export interface SlashMenuPopupProps {
  query: string
  matches: readonly SlashMenuEntry[]
  index: number
}

/** Live "/" command popup, overlaid above InputBox the same way MentionPopup is —
 *  bordered box, windowed scrollable list, inverse highlight on the active row (same
 *  visual language as the @-mention popup, in a different accent color so the two
 *  never get confused for one another at a glance). Purely presentational: InputBox
 *  owns all filtering/key handling and just feeds this component the already-filtered
 *  matches and the active index. Plugin-namespaced entries get a dim "[plugin]" tag so
 *  they read as visually distinct from built-ins and personal/project custom commands. */
export function SlashMenuPopup({ query, matches, index }: SlashMenuPopupProps) {
  if (matches.length === 0) {
    return (
      <Box borderStyle="round" borderColor="yellow" paddingX={1}>
        <Text dimColor>No commands match /{query}</Text>
      </Box>
    )
  }
  // Windowed render: keep the selection visible without drawing an unbounded list.
  const start = Math.min(Math.max(0, index - WINDOW + 1), Math.max(0, matches.length - WINDOW))
  const visible = matches.slice(start, start + WINDOW)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        /{query} (↑/↓ select, Tab/Enter confirm, Esc cancel)
      </Text>
      {start > 0 && <Text dimColor>… {start} earlier</Text>}
      {visible.map((entry, i) => {
        const abs = start + i
        const active = abs === index
        return (
          <Text
            key={entry.name}
            color={active ? 'yellow' : undefined}
            inverse={active}
            dimColor={!active && entry.source === 'plugin'}
          >
            /{entry.name}
            {entry.source === 'plugin' ? ' [plugin]' : ''}
            {entry.description ? ` — ${entry.description}` : ''}
          </Text>
        )
      })}
      {start + WINDOW < matches.length && <Text dimColor>… {matches.length - start - WINDOW} more</Text>}
    </Box>
  )
}
