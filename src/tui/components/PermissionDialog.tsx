// src/tui/components/PermissionDialog.tsx
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { useMemo } from 'react'
import { Box, Text, useInput } from 'ink'
import type { PendingPermission } from '../App.js'
import { DiffPreview } from './DiffPreview.js'

/** What a Write/Edit approval would actually change; null for non-file tools.
 *  Write diffs current file content (when it exists) against the new content;
 *  Edit diffs old_string against new_string. */
export function pendingDiff(
  pending: Pick<PendingPermission, 'toolName' | 'input'>,
  cwd: string,
): { oldText: string; newText: string } | null {
  if (typeof pending.input !== 'object' || pending.input === null) return null
  const input = pending.input as Record<string, unknown>
  if (pending.toolName === 'Edit') {
    return { oldText: String(input['old_string'] ?? ''), newText: String(input['new_string'] ?? '') }
  }
  if (pending.toolName === 'Write') {
    if (typeof input['file_path'] !== 'string') return null
    let oldText = ''
    try {
      const abs = resolve(cwd, input['file_path'])
      if (existsSync(abs)) oldText = readFileSync(abs, 'utf8')
    } catch {
      /* unreadable current content: fall back to an all-additions diff */
    }
    return { oldText, newText: String(input['content'] ?? '') }
  }
  return null
}

export function PermissionDialog({ pending, cwd }: { pending: PendingPermission; cwd: string }) {
  useInput((ch) => {
    if (ch === 'y') pending.resolve('allow-once')
    else if (ch === 'a') pending.resolve('allow-always')
    else if (ch === 'n') pending.resolve('deny')
  })
  // Memoized on the pending request: pendingDiff reads the target file for
  // Write, and must not hit the filesystem again on every re-render.
  const diff = useMemo(() => pendingDiff(pending, cwd), [pending, cwd])
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        Permission required
      </Text>
      <Text>{pending.summary}</Text>
      <Text dimColor>{pending.reason}</Text>
      {diff && <DiffPreview oldText={diff.oldText} newText={diff.newText} />}
      <Text>[y] allow once   [a] always allow (writes rule)   [n] deny</Text>
    </Box>
  )
}
