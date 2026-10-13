import { Box, Text, useInput } from 'ink'
import type { PendingPermission } from '../App.js'
import { safeDetailText } from '../../presentation/action-details.js'
import { truncateTextToRows, wrappedRowCount } from '../viewport.js'

/** Full-frame fallback: no hidden input, status, or diff competes with consent. */
export function CompactPermission({ pending, rows, columns, onInspect }: {
  pending: PendingPermission; rows: number; columns: number; onInspect: (grant: boolean) => void
}) {
  const footer = 'y allow once | a grant review | n deny | d details | Esc deny'
  const footerRows = wrappedRowCount(footer, columns)
  const readable = columns >= 20 && rows >= footerRows + 3
  useInput((ch, key) => {
    if (key.escape) { pending.resolve('deny'); return }
    if (key.ctrl || key.meta || key.shift) return
    if (!readable) return
    if (ch === 'n' || ch === 'x') pending.resolve('deny')
    else if (ch === 'y') pending.resolve('allow-once')
    else if (ch === 'a') onInspect(true)
    else if (ch === 'd') onInspect(false)
  })
  if (!readable) {
    return <Box height={Math.max(1, rows)}><Text>{truncateTextToRows('Esc deny. Resize to review.', columns, Math.max(1, rows))}</Text></Box>
  }
  return <Box height={rows} flexDirection="column">
    <Text bold>Permission required</Text>
    <Text>{truncateTextToRows(safeDetailText(pending.summary), columns, 1)}</Text>
    <Box height={Math.max(1, rows - footerRows - 2)} overflow="hidden">
      <Text>{truncateTextToRows(safeDetailText(pending.reason), columns, Math.max(1, rows - footerRows - 2))}</Text>
    </Box>
    <Text>{footer}</Text>
  </Box>
}
