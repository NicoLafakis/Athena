import { describe, it, expect, vi } from 'vitest'
import { render } from 'ink-testing-library'
import { Box, Text } from 'ink'
import { composerRows, useInputBox } from '../../src/tui/components/InputBox.js'
import { displayWidth } from '../../src/tui/viewport.js'
import { deleteBackward, deleteForward, clampCursor, prevWordBoundary } from '../../src/tui/cursor.js'
import { DiffPreview } from '../../src/tui/components/DiffPreview.js'

const tick = () => new Promise(resolve => setTimeout(resolve, 20))
function Composer({ onSubmit, columns = 12, maxRows = 3 }: { onSubmit: (s: string) => void; columns?: number; maxRows?: number }) {
  const input = useInputBox({ onSubmit, columns, maxRows, disabled: false, cwd: process.cwd() })
  return <Box width={columns} flexDirection="column">{input.element}<Text>ROWS:{input.rows}</Text></Box>
}

describe('composer physical rows and graphemes', () => {
  it('word movement does not split a whitespace grapheme with a combining mark', () => {
    expect(prevWordBoundary('a \u0301b', 4)).toBe(3)
  })
  it.each([40, 80, 120])('keeps wide and combined graphemes whole at width %i', columns => {
    const draft = '界👩‍💻e\u0301'.repeat(150)
    const rows = composerRows(draft, draft.length, columns, 4)
    expect(rows).toHaveLength(4)
    expect(rows.every(row => displayWidth(row.text) + 2 <= columns)).toBe(true)
    expect(rows.map(row => row.text).join('')).not.toContain('\ufffd')
    expect(rows.at(-1)?.caret).toBeDefined()
  })
  it('reserves a caret cell at a full logical line ending', () => {
    const rows = composerRows('abcdefghij\nnext', 10, 12, 4)
    const current = rows.find(row => row.caret !== undefined)!
    expect(displayWidth(current.text) + 3).toBeLessThanOrEqual(12)
  })
  it.each(['👩‍💻', 'e\u0301', '🇺🇸'])('deletes a complete %s grapheme', cluster => {
    expect(deleteBackward(`a${cluster}b`, 1 + cluster.length)).toEqual({ value: 'ab', cursor: 1 })
    expect(deleteForward(`a${cluster}b`, 1)).toEqual({ value: 'ab', cursor: 1 })
    expect(clampCursor(`a${cluster}b`, 2)).toBe(1)
  })
  it('bounds a wrapped draft, follows cursor, and retains the submitted text', async () => {
    const submit = vi.fn()
    const view = render(<Composer onSubmit={submit} />)
    await tick()
    const draft = 'a'.repeat(80) + 'TAIL'
    view.stdin.write(draft)
    await tick()
    expect(view.lastFrame()).toContain('TAIL')
    expect(view.lastFrame()).toContain('ROWS:3')
    expect(view.lastFrame()!.split('\n')).toHaveLength(4)
    view.stdin.write('\u0001')
    await tick()
    expect(view.lastFrame()).not.toContain('TAIL')
    view.stdin.write('\r')
    await tick()
    expect(submit).toHaveBeenCalledWith(draft)
    view.unmount()
  })
  it.each(['/mo', '@missing'])('hidden %s popup cannot consume Enter', async seed => {
    const submit = vi.fn()
    const view = render(<Composer onSubmit={submit} maxRows={1} columns={40} />)
    await tick()
    view.stdin.write(seed)
    await tick()
    view.stdin.write('\r')
    await tick()
    expect(submit).toHaveBeenCalledWith(seed)
    view.unmount()
  })
  it('moves across a whole cluster before inserting', async () => {
    const submit = vi.fn()
    const view = render(<Composer onSubmit={submit} />)
    await tick()
    view.stdin.write('a👩‍💻')
    await tick()
    view.stdin.write('\u001b[D')
    await tick()
    view.stdin.write('X')
    await tick()
    view.stdin.write('\r')
    await tick()
    expect(submit).toHaveBeenCalledWith('aX👩‍💻')
    view.unmount()
  })
  it('limits diff content by physical rows including prefixes', () => {
    const view = render(<Box width={12}><DiffPreview oldText="" newText={'x'.repeat(80)} maxLines={2} columns={12} /></Box>)
    expect(view.lastFrame()!.split('\n').filter(line => line.includes('x')).length).toBeLessThanOrEqual(2)
    expect(view.lastFrame()).toContain('truncated')
    view.unmount()
  })
})
