// src/tui/components/DiffPreview.tsx
import { Box, Text } from 'ink'
import { truncateWithNotice, wrappedRowCount } from '../viewport.js'

export interface DiffLine {
  tag: '+' | '-' | ' '
  line: string
}

/** Above this per-side line count the O(n*m) LCS is skipped so the TUI can't hang. */
const MAX_LCS_LINES = 500

/** Line-based LCS diff; falls back to a plain old/new listing for very large inputs. */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  // Empty text means "no lines" (new or emptied file), not one empty line —
  // otherwise a Write of a new file shows a bogus leading "-" removal.
  const a = oldText === '' ? [] : oldText.split('\n')
  const b = newText === '' ? [] : newText.split('\n')
  const m = a.length
  const n = b.length
  if (m > MAX_LCS_LINES || n > MAX_LCS_LINES) {
    return [
      ...a.map((line): DiffLine => ({ tag: '-', line })),
      ...b.map((line): DiffLine => ({ tag: '+', line })),
    ]
  }
  // LCS length table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ tag: ' ', line: a[i]! })
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ tag: '-', line: a[i]! })
      i++
    } else {
      out.push({ tag: '+', line: b[j]! })
      j++
    }
  }
  while (i < m) out.push({ tag: '-', line: a[i++]! })
  while (j < n) out.push({ tag: '+', line: b[j++]! })
  return out
}

/** Historical safety cap used when no caller-supplied budget applies (classic mode,
 *  or any other caller that hasn't been sized to an actual layout). Fullscreen mode
 *  passes an explicit `maxLines` computed from the real remaining terminal rows instead
 *  (see App.tsx) — the point of that budget is to never silently drop/interleave diff
 *  lines the way an unbounded render into a fixed-height layout can (see the
 *  Yoga/Ink layout-corruption fix this constant is part of). */
const DEFAULT_MAX_LINES = 40

/** The "+N more..." truncation notice — in a full, helpful form (with the "widen
 *  terminal..." hint) when that comfortably fits the available width, falling back to a
 *  short form when it wouldn't. A narrow terminal + an unconditionally-verbose notice was
 *  itself a second, independently-found instance of the fullscreen layout-corruption bug:
 *  reserving room for the ~85-character full notice made even a zero-diff-content dialog
 *  too tall to fit a 40-column terminal. Exported so App.tsx's row budgeting can reserve
 *  the SAME (worst-case) row count this component will actually render, using a
 *  pessimistic placeholder hidden-count — see DiffPreview's caller in App.tsx. */
export function diffNoticeText(hiddenCount: number, columns: number): string {
  const full = `+${hiddenCount} more lines truncated (widen terminal or /tui classic to review the full diff)`
  if (wrappedRowCount(full, columns) <= 2) return full
  return `+${hiddenCount} more lines truncated`
}

export function DiffPreview({
  oldText,
  newText,
  maxLines = DEFAULT_MAX_LINES,
  columns = 76,
}: {
  oldText: string
  newText: string
  /** Max diff CONTENT lines to render before truncating — a content-only budget; it does
   *  NOT need to leave room for the "+N more" notice itself (the caller already reserved
   *  that separately — see App.tsx). Defaults to DEFAULT_MAX_LINES when the caller hasn't
   *  computed a real layout budget. */
  maxLines?: number
  /** Terminal columns actually available to this component's own text (i.e. AFTER the
   *  parent PermissionDialog's border/padding has already been subtracted) — used only to
   *  pick the notice's full-vs-short form above. Defaults to 76 (an 80-column terminal
   *  minus PermissionDialog's border+padding), matching the assumption DEFAULT_MAX_LINES
   *  itself is sized against. */
  columns?: number
}) {
  const lines = diffLines(oldText, newText)
  const { shown, hiddenCount } = truncateWithNotice(lines, maxLines)
  return (
    <Box flexDirection="column">
      {shown.map((l, idx) => (
        <Text
          key={idx}
          color={l.tag === '+' ? 'green' : l.tag === '-' ? 'red' : undefined}
          dimColor={l.tag === ' '}
        >
          {l.tag} {l.line}
        </Text>
      ))}
      {hiddenCount > 0 && <Text dimColor>{diffNoticeText(hiddenCount, columns)}</Text>}
    </Box>
  )
}
