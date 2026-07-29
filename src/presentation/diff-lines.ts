export interface DiffLine {
  tag: '+' | '-' | ' '
  line: string
}

const MAX_LCS_LINES = 500

/** Framework-neutral line diff shared by Ink and accessible permission output. */
export function diffLines(oldText: string, newText: string): DiffLine[] {
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
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j]
        ? dp[i + 1]![j + 1]! + 1
        : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
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
      out.push({ tag: '-', line: a[i++]! })
    } else {
      out.push({ tag: '+', line: b[j++]! })
    }
  }
  while (i < m) out.push({ tag: '-', line: a[i++]! })
  while (j < n) out.push({ tag: '+', line: b[j++]! })
  return out
}
