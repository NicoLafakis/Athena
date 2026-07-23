// src/tui/components/PermissionDialog.tsx
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { useMemo } from 'react'
import { Box, Text, useInput } from 'ink'
import type { PendingPermission } from '../App.js'
import { DiffPreview } from './DiffPreview.js'
import { truncateTextToRows } from '../viewport.js'

// Exported (rather than inlined literals in the JSX below) so App.tsx's fullscreen row
// budgeting can measure their ACTUAL wrapped row count at the current terminal width
// (see wrappedRowCount in viewport.ts) instead of assuming both are always exactly one
// row — the footer in particular is ~58 characters and wraps well before an 80-column
// terminal narrows much. A single source of truth means the measurement can never drift
// from what's actually rendered.
export const PERMISSION_HEADER_TEXT = 'Permission required'
export const PERMISSION_FOOTER_TEXT = '[y] allow once   [a] always allow (writes rule)   [n] deny'

// Columns eaten by borderStyle="round" (1 col each side) + paddingX={1} (1 col each
// side) before any of this dialog's own text actually starts wrapping. Exported so
// App.tsx's row budgeting uses the SAME effective width this component actually renders
// into (and so it can hand DiffPreview that same effective width for ITS notice sizing).
export const DIALOG_HORIZONTAL_CHROME_COLS = 4

// Hard ceilings on how many rows `summary`/`reason` are allowed to display as,
// regardless of how long the underlying text is or how narrow the terminal gets —
// summary in particular is engine-controlled (summarize() in engine/loop.ts truncates it
// to ~120 chars, which alone can still wrap to 3-4+ rows at a narrow terminal). Without
// a ceiling, a sufficiently long summary at a sufficiently narrow terminal makes even the
// chrome ALONE (before any diff content) too tall to fit — reproduced independently at
// 40 cols/16 rows. Exported so App.tsx's row budgeting matches exactly what gets shown.
export const DIALOG_SUMMARY_MAX_ROWS = 4
export const DIALOG_REASON_MAX_ROWS = 2

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

export function PermissionDialog({
  pending,
  cwd,
  maxDiffLines,
  columns = 80,
}: {
  pending: PendingPermission
  cwd: string
  /** Real remaining-rows budget for the diff view, computed by App.tsx from the actual
   *  terminal size minus StatusLine/InputBox/this dialog's own chrome (fullscreen mode
   *  only). Undefined in classic mode, where DiffPreview falls back to its own static
   *  safety cap — native scrollback means there's no fixed-height layout to protect. */
  maxDiffLines?: number
  /** Raw terminal column count — this dialog subtracts its own border/padding (see
   *  DIALOG_HORIZONTAL_CHROME_COLS) to get the width actually available to its text.
   *  Defaults to 80, matching Banner's own default. */
  columns?: number
}) {
  useInput((ch) => {
    if (ch === 'y') pending.resolve('allow-once')
    else if (ch === 'a') pending.resolve('allow-always')
    else if (ch === 'n') pending.resolve('deny')
  })
  // Memoized on the pending request: pendingDiff reads the target file for
  // Write, and must not hit the filesystem again on every re-render.
  const diff = useMemo(() => pendingDiff(pending, cwd), [pending, cwd])
  const effectiveColumns = Math.max(columns - DIALOG_HORIZONTAL_CHROME_COLS, 1)
  const displaySummary = truncateTextToRows(pending.summary, effectiveColumns, DIALOG_SUMMARY_MAX_ROWS)
  const displayReason = truncateTextToRows(pending.reason, effectiveColumns, DIALOG_REASON_MAX_ROWS)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        {PERMISSION_HEADER_TEXT}
      </Text>
      <Text>{displaySummary}</Text>
      <Text dimColor>{displayReason}</Text>
      {diff && (
        <DiffPreview oldText={diff.oldText} newText={diff.newText} maxLines={maxDiffLines} columns={effectiveColumns} />
      )}
      <Text>{PERMISSION_FOOTER_TEXT}</Text>
    </Box>
  )
}
