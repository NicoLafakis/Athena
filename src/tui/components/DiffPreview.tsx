// src/tui/components/DiffPreview.tsx
import { Box, Text } from 'ink'

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

const MAX_LINES = 40

export function DiffPreview({ oldText, newText }: { oldText: string; newText: string }) {
  const lines = diffLines(oldText, newText)
  const shown = lines.slice(0, MAX_LINES)
  const truncated = lines.length > MAX_LINES
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
      {truncated && <Text dimColor>(diff truncated)</Text>}
    </Box>
  )
}
