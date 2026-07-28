// src/tui/components/SlashMenuPopup.tsx
import { Box, Text } from 'ink'
import type { SlashMenuEntry } from '../slashMenu.js'
import { popupLine, popupTextColumns, type PopupLayout } from '../popupWindow.js'

export interface SlashMenuPopupProps {
  query: string
  matches: readonly SlashMenuEntry[]
  index: number
  /** Which slice to draw and how tall it is, computed by the OWNER (InputBox) via
   *  popupLayout — see popupWindow.ts and MentionPopup's identical prop. */
  layout: PopupLayout
  /** Terminal column count, so every row can be held to exactly one row (popupLine). */
  columns?: number
}

/** Live "/" command popup, overlaid above InputBox the same way MentionPopup is —
 *  bordered box, windowed scrollable list, inverse highlight on the active row (same
 *  visual language as the @-mention popup, in a different accent color so the two
 *  never get confused for one another at a glance). Purely presentational: InputBox
 *  owns all filtering/key handling and just feeds this component the already-filtered
 *  matches and the active index. Plugin-namespaced entries get a dim "[plugin]" tag so
 *  they read as visually distinct from built-ins and personal/project custom commands. */
export function SlashMenuPopup({ query, matches, index, layout, columns = 80 }: SlashMenuPopupProps) {
  const width = popupTextColumns(columns)
  if (matches.length === 0) {
    return (
      <Box borderStyle="round" borderColor="yellow" paddingX={1}>
        <Text dimColor>{popupLine(`No commands match /${query}`, width)}</Text>
      </Box>
    )
  }
  // Windowed render: keep the selection visible without drawing an unbounded list. The
  // window itself comes from `layout` (popupWindow.ts) rather than being recomputed here.
  const { start, count } = layout
  const visible = matches.slice(start, start + count)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        {popupLine(`/${query} (↑/↓ select, Tab/Enter confirm, Esc cancel)`, width)}
      </Text>
      {start > 0 && <Text dimColor>… {start} earlier</Text>}
      {visible.map((entry, i) => {
        const abs = start + i
        const active = abs === index
        const tag = entry.source === 'plugin' ? ' [plugin]' : ''
        const tail = entry.description ? ` — ${entry.description}` : ''
        return (
          <Text
            key={entry.name}
            color={active ? 'yellow' : undefined}
            inverse={active}
            dimColor={!active && entry.source === 'plugin'}
          >
            {popupLine(`/${entry.name}${tag}${tail}`, width)}
          </Text>
        )
      })}
      {start + count < matches.length && <Text dimColor>… {matches.length - start - count} more</Text>}
    </Box>
  )
}
