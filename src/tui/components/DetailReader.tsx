import { useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { safeDetailText } from '../../presentation/action-details.js'
import { truncateTextToRows, wrapToRows, wrappedRowCount } from '../viewport.js'

/** Full-frame local reader. Its row budget includes every heading, footer and notice. */
export function DetailReader({ title, text, rows, columns, onClose, onExport, onGrant, onDeny, onPrevious, onNext }: {
  title: string; text: string; rows: number; columns: number; onClose: () => void
  onExport?: (text: string) => Promise<string>
  onGrant?: () => void; onDeny?: () => void
  onPrevious?: () => void; onNext?: () => void
}) {
  const safe = useMemo(() => safeDetailText(text), [text])
  const lines = useMemo(() => wrapToRows(safe, columns), [safe, columns])
  const [offset, setOffset] = useState(0)
  const [query, setQuery] = useState<string | null>(null)
  const [lastQuery, setLastQuery] = useState('')
  const [lastMatch, setLastMatch] = useState(-1)
  const [notice, setNotice] = useState('')
  const footer = [
    ...(onGrant ? ['a grant session'] : []), ...(onDeny ? ['x deny'] : []),
    'PgUp/PgDn / find n next', ...(onExport ? ['e export'] : []), 'Esc back',
  ].join(' | ')
  const footerRows = wrappedRowCount(footer, columns)
  const readable = columns >= 20 && rows >= footerRows + 3
  const page = Math.max(1, rows - 2 - footerRows)
  const start = Math.min(offset, Math.max(0, lines.length - page))
  const find = (term: string, after: number) => {
    if (!term) return
    const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
    pattern.lastIndex = after
    const match = pattern.exec(safe)
    if (!match) { setNotice('No further match'); return }
    // Search logical text before wrapping; a match may span several rows.
    // Map its original character offset through the full wrapped logical line
    // so word wrapping and wide graphemes use the same rows as rendering.
    let sourceOffset = 0
    let rowOffset = 0
    for (const logical of safe.split('\n')) {
      const wrapped = wrapToRows(logical, columns)
      if (match.index <= sourceOffset + logical.length) {
        let local = match.index - sourceOffset
        let row = 0
        while (row < wrapped.length - 1 && local >= wrapped[row]!.length) {
          local -= wrapped[row]!.length
          row++
        }
        setOffset(rowOffset + row)
        break
      }
      sourceOffset += logical.length + 1
      rowOffset += wrapped.length
    }
    setLastMatch(match.index)
    setNotice('')
  }
  useInput((ch, key) => {
    if (!readable) {
      if (key.escape) onClose()
      return
    }
    if (query !== null) {
      if (key.escape) { setQuery(null); return }
      if (key.return) { setLastQuery(query); find(query, 0); setQuery(null); return }
      if (key.backspace || key.delete) { setQuery(Array.from(query).slice(0, -1).join('')); return }
      if (!key.ctrl && !key.meta && ch) setQuery(query + ch)
      return
    }
    if (key.escape || ch === 'q') { onClose(); return }
    if (key.ctrl || key.meta || key.shift) return
    if (ch === 'a' && onGrant) { onGrant(); return }
    if (ch === 'x' && onDeny) { onDeny(); return }
    if (ch === '[') { onPrevious?.(); return }
    if (ch === ']') { onNext?.(); return }
    if (key.pageDown || ch === ' ') setOffset(Math.min(start + page, Math.max(0, lines.length - page)))
    else if (key.pageUp) setOffset(Math.max(0, start - page))
    else if (key.downArrow) setOffset(Math.min(start + 1, Math.max(0, lines.length - page)))
    else if (key.upArrow) setOffset(Math.max(0, start - 1))
    else if (ch === '/') setQuery('')
    else if (ch === 'n' && lastQuery) find(lastQuery, lastMatch + 1)
    else if (ch === 'e' && onExport) {
      setNotice('Exporting…')
      void onExport(safe).then(path => setNotice(`Saved: ${path}`), error => setNotice(`Export failed: ${String(error)}`))
    }
  })
  if (!readable) {
    return <Box height={Math.max(1, rows)}><Text>{truncateTextToRows('Resize to review; Esc closes.', columns, Math.max(1, rows))}</Text></Box>
  }
  return <Box flexDirection="column" height={rows}>
    <Text bold>{truncateTextToRows(`${title} (${start + 1}-${Math.min(lines.length, start + page)}/${lines.length})`, columns, 1)}</Text>
    <Box flexDirection="column" height={page} overflow="hidden"><Text>{lines.slice(start, start + page).join('\n')}</Text></Box>
    <Text>{truncateTextToRows(query !== null ? `Find: ${query}` : notice || (onPrevious ? '[ / ] previous / next tool' : 'Local inspection; no action executed'), columns, 1)}</Text>
    <Text>{footer}</Text>
  </Box>
}
