// src/tui/components/FileMentionPopup.tsx
import { Box, Text } from 'ink'

const WINDOW = 8

export interface FileMentionPopupProps {
  query: string
  matches: readonly string[]
  index: number
  /** True while the initial project file walk is still in flight — distinguishes
   *  "nothing matched yet" from "no files indexed yet" in the empty state. */
  loading?: boolean
}

/** @-mention fuzzy file picker, overlaid above InputBox the same way PermissionDialog
 *  overlays it — bordered box, windowed list, inverse highlight on the active row
 *  (same visual language as SessionPicker). Purely presentational: InputBox owns all
 *  the key handling and just feeds this component query/matches/index. */
export function FileMentionPopup({ query, matches, index, loading }: FileMentionPopupProps) {
  if (matches.length === 0) {
    return (
      <Box borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text dimColor>{loading ? 'Indexing project files…' : `No files match @${query}`}</Text>
      </Box>
    )
  }
  // Windowed render: keep the selection visible without drawing an unbounded list.
  const start = Math.min(Math.max(0, index - WINDOW + 1), Math.max(0, matches.length - WINDOW))
  const visible = matches.slice(start, start + WINDOW)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        @{query} (↑/↓ select, Tab/Enter confirm, Esc cancel)
      </Text>
      {start > 0 && <Text dimColor>… {start} earlier</Text>}
      {visible.map((path, i) => {
        const abs = start + i
        return (
          <Text key={path} color={abs === index ? 'cyan' : undefined} inverse={abs === index}>
            {path}
          </Text>
        )
      })}
      {start + WINDOW < matches.length && <Text dimColor>… {matches.length - start - WINDOW} more</Text>}
    </Box>
  )
}
