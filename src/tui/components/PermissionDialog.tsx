// src/tui/components/PermissionDialog.tsx
import { Box, Text, useInput } from 'ink'
import type { PendingPermission } from '../App.js'

export function PermissionDialog({ pending }: { pending: PendingPermission }) {
  useInput((ch) => {
    if (ch === 'y') pending.resolve('allow-once')
    else if (ch === 'a') pending.resolve('allow-always')
    else if (ch === 'n') pending.resolve('deny')
  })
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        Permission required
      </Text>
      <Text>{pending.summary}</Text>
      <Text dimColor>{pending.reason}</Text>
      <Text>[y] allow once   [a] always allow (writes rule)   [n] deny</Text>
    </Box>
  )
}
