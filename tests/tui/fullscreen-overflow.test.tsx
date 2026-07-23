// tests/tui/fullscreen-overflow.test.tsx — verifies the fullscreen layout-corruption fix
// (see App.tsx's per-sibling row budgeting, which is column-AND-row aware: BANNER_ROWS/
// TODO_BORDER_ROWS/DIALOG_BORDER_ROWS/HORIZONTAL_CHROME_COLS/MIN_TRANSCRIPT_ROWS, plus
// wrappedRowCount for every piece of text-bearing chrome). Only the Transcript-wrapping
// Box has overflow="hidden" — Banner, TodoPanel, PermissionDialog, InputBox, and
// StatusLine are all siblings of a fixed height={rows} column Box with none of their own,
// so letting any of them render more content (or WRAP to more rows) than actually fits
// corrupts the whole frame instead of just clipping. Exercises the reviewer's exact repro
// (30-row TTY, 5 todos, a pending Edit permission carrying a 12-line diff), the truncation
// branches that repro alone doesn't reach (content too big even for the computed budget
// must show a visible "+N more" count, never a silent/partial/jumbled render), AND a
// narrow-terminal + long-summary case (a realistic ~127-char PermissionDialog summary
// wraps to several rows well before an 80-column terminal narrows much — hardcoding that
// as "1 row" was a second, independently-found instance of the same corruption class).
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ReactNode } from 'react'
import { render as inkRender } from 'ink'
import { App, PermissionBridge } from '../../src/tui/App.js'
import { EngineEventBus } from '../../src/engine/events.js'
import { wrappedRowCount } from '../../src/tui/viewport.js'
import { PERMISSION_HEADER_TEXT, PERMISSION_FOOTER_TEXT } from '../../src/tui/components/PermissionDialog.js'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function makeProps() {
  const bus = new EngineEventBus()
  return {
    bus,
    status: {
      cwd: 'C:/proj',
      gitBranch: 'main',
      model: 'kimi-k2.7-code',
      effort: 'high',
      mode: 'normal' as const,
      contextPct: 0,
    },
    onSubmit: vi.fn(async () => {}),
    onSlash: vi.fn(),
    onAbort: vi.fn(),
    permissionBridge: new PermissionBridge(),
  }
}

// Faithful copies of ink-testing-library's internal stream doubles (see
// tests/tui/fullscreen-default.test.tsx for the original) with a configurable row count
// so each test below can target a specific budget boundary. ink-testing-library's own
// `render()` always builds a non-TTY double with no `.isTTY` at all and no way to
// override it, so exercising fullscreen mode requires driving Ink's own `render` directly
// with a hand-built stream trio instead.
class TtyStdout extends EventEmitter {
  isTTY = true
  frames: string[] = []
  write = (frame: string): boolean => {
    this.frames.push(frame)
    return true
  }
  constructor(
    public columns: number,
    public rows: number,
  ) {
    super()
  }
}

class TtyStderr extends EventEmitter {
  write = (): boolean => true
}

class TtyStdin extends EventEmitter {
  isTTY = true
  private data: string | null = null
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read = (): string | null => {
    const { data } = this
    this.data = null
    return data
  }
  write = (data: string): void => {
    this.data = data
    this.emit('readable')
    this.emit('data', data)
  }
}

function renderOnTty(node: ReactNode, rows: number, columns = 80): { stdout: TtyStdout } {
  const stdout = new TtyStdout(columns, rows)
  const stdin = new TtyStdin()
  const stderr = new TtyStderr()
  inkRender(node, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  return { stdout }
}

/** The most recently written frame — the settled render, NOT the union of every frame
 *  ever written. Joining all frames would still contain stale content from before a
 *  state change (e.g. the banner from before a permission dialog appeared), which is
 *  exactly wrong for the "is X now absent" assertions this file needs. */
function lastFrame(stdout: TtyStdout): string {
  return stdout.frames.at(-1) ?? ''
}

describe('fullscreen layout-corruption fix', () => {
  it('reviewer repro: 30-row TTY, 5 todos, a pending Edit permission with a 12-line diff', async () => {
    const props = makeProps()
    const { stdout } = renderOnTty(<App {...props} />, 30, 80)
    await delay(10)

    props.bus.emit({
      type: 'todo-update',
      todos: Array.from({ length: 5 }, (_, i) => ({ text: `todo-${i + 1}`, status: 'pending' as const })),
    })
    await delay(10)

    const oldLines = Array.from({ length: 6 }, (_, i) => `old-line-${i + 1}`)
    const newLines = Array.from({ length: 6 }, (_, i) => `new-line-${i + 1}`)
    props.permissionBridge.ask({
      toolName: 'Edit',
      input: { file_path: 'f.txt', old_string: oldLines.join('\n'), new_string: newLines.join('\n') },
      summary: 'Edit(f.txt)',
      reason: 'mutating tool',
    })
    await delay(20)

    const frame = lastFrame(stdout)

    // The dialog's own header is always visible.
    expect(frame).toContain('Permission required')

    // Banner and TodoPanel are hidden outright while the dialog is pending (visual
    // priority — see App.tsx's showBanner/showTodoPanel) rather than partially rendered
    // or silently dropped mid-frame: simply absent, an intentional binary state.
    expect(frame).not.toContain('ATHENA')
    for (let i = 1; i <= 5; i++) expect(frame).not.toContain(`todo-${i}`)

    // All 12 diff lines present, fully and contiguously (never jumbled/partial): the
    // dynamic budget at 30 rows (19 diff-line rows once Banner/TodoPanel stop competing
    // for space) comfortably covers a 12-line diff, so no truncation notice appears.
    for (const line of oldLines) expect(frame).toContain(`- ${line}`)
    for (const line of newLines) expect(frame).toContain(`+ ${line}`)
    expect(frame).not.toContain('more lines truncated')
  })

  it('a diff too big even for the fullscreen budget is visibly truncated with an exact count, never silently dropped', async () => {
    const props = makeProps()
    const { stdout } = renderOnTty(<App {...props} />, 15, 80)
    await delay(10)

    const oldLines = Array.from({ length: 10 }, (_, i) => `old-${i + 1}`)
    const newLines = Array.from({ length: 10 }, (_, i) => `new-${i + 1}`)
    props.permissionBridge.ask({
      toolName: 'Edit',
      input: { file_path: 'f.txt', old_string: oldLines.join('\n'), new_string: newLines.join('\n') },
      summary: 'Edit(f.txt)',
      reason: 'mutating tool',
    })
    await delay(20)

    const frame = lastFrame(stdout)
    expect(frame).toContain('Permission required') // header survives truncation

    // Budget at 15 rows/80 cols: 15 - 1 (status) - 1 (input) - 3 (transcript floor) - 8
    // (dialog chrome: 2 border + 1 header + 1 summary + 1 reason + 1 footer + 2 for the
    // "+N more..." notice reservation, which now ALSO wraps at this width) = 2 diff
    // rows -- a content-only budget (DiffPreview doesn't steal a row from it for its own
    // notice; that room was already reserved above). 2 lines show (all-removal, since the
    // disjoint old/new lines diff as all '-' then all '+') and the rest are counted, never
    // interleaved or silently cut off.
    expect(frame).toContain('- old-1')
    expect(frame).toContain('- old-2')
    expect(frame).not.toContain('- old-3') // beyond the content budget -- must be absent, not jumbled in
    expect(frame).toContain('+18 more lines truncated')
    expect(frame).not.toContain('new-1') // none of the additions fit in this budget
  })

  it('a todo list too big for the fullscreen budget (no dialog pending) is visibly truncated with an exact count', async () => {
    const props = makeProps()
    const { stdout } = renderOnTty(<App {...props} />, 16, 80)
    await delay(10)

    props.bus.emit({
      type: 'todo-update',
      todos: Array.from({ length: 8 }, (_, i) => ({ text: `todo-${i + 1}`, status: 'pending' as const })),
    })
    await delay(20)

    const frame = lastFrame(stdout)
    // No dialog pending, so the banner and the (bounded) todo panel both show.
    expect(frame).toContain('ATHENA')

    // Budget at 16 rows: 16 - 1 (status) - 1 (input) - 4 (banner) - 3 (transcript floor)
    // - 2 (todo chrome) = 5 item rows. truncateWithNotice reserves 1 for the notice, so 4
    // todos show and 4 are counted rather than silently vanishing.
    for (let i = 1; i <= 4; i++) expect(frame).toContain(`todo-${i}`)
    for (let i = 5; i <= 8; i++) expect(frame).not.toContain(`todo-${i}`)
    expect(frame).toContain('+4 more')
  })

  it('narrow terminal (40 cols/16 rows) + a realistic long summary: header survives, diff truncates with a correct count', async () => {
    const props = makeProps()
    const columns = 40
    const rowsTotal = 16
    const { stdout } = renderOnTty(<App {...props} />, rowsTotal, columns)
    await delay(10)

    // Mirrors summarize()'s real output shape (engine/loop.ts: `${toolName}(${input up to
    // ~120 chars}…)`) -- long enough that it MUST wrap at 40 columns. This is exactly the
    // second defect an independent re-verification found: DIALOG_CHROME_ROWS used to
    // hardcode the summary/reason/header/footer as exactly one row each regardless of
    // terminal width, so a summary this long silently pushed the whole dialog (including
    // the header) over budget at anything narrower than ~130 columns.
    const summary = `Edit(${'a'.repeat(120)}…)`
    const reason = 'Edit is mutating; no rule matched in normal mode'
    expect(summary.length).toBeGreaterThan(100) // sanity: this really does need to wrap at 40 cols

    const oldLines = Array.from({ length: 8 }, (_, i) => `old-${i + 1}`)
    const newLines = Array.from({ length: 8 }, (_, i) => `new-${i + 1}`)
    props.permissionBridge.ask({
      toolName: 'Edit',
      input: { file_path: 'f.txt', old_string: oldLines.join('\n'), new_string: newLines.join('\n') },
      summary,
      reason,
    })
    await delay(20)

    const frame = lastFrame(stdout)

    // (a) The header must never disappear, however tight the diff budget gets -- it's
    // outside the truncatable budget entirely (see App.tsx: only diff lines shrink).
    expect(frame).toContain('Permission required')

    // Independently reconstruct the expected diff budget using the SAME column-aware
    // helper (and the SAME exported header/footer text) App.tsx uses, so this assertion
    // tracks the real fix rather than a hand-counted magic number that could drift.
    const HORIZONTAL_CHROME_COLS = 4 // border(2 cols) + paddingX(2 cols), see App.tsx
    const effectiveCols = Math.max(columns - HORIZONTAL_CHROME_COLS, 1)
    const dialogChromeRows =
      2 + // border top+bottom
      wrappedRowCount(PERMISSION_HEADER_TEXT, effectiveCols) +
      wrappedRowCount(summary, effectiveCols) +
      wrappedRowCount(reason, effectiveCols) +
      wrappedRowCount(PERMISSION_FOOTER_TEXT, effectiveCols)
    const STATUS_LINE_ROWS_EXPECTED = 1 // short status text easily fits one row even at 40 cols
    const INPUT_ROWS_EXPECTED = 1
    const MIN_TRANSCRIPT_ROWS_EXPECTED = 3
    const maxDiffLines = Math.max(
      rowsTotal - STATUS_LINE_ROWS_EXPECTED - INPUT_ROWS_EXPECTED - MIN_TRANSCRIPT_ROWS_EXPECTED - dialogChromeRows,
      0,
    )
    const totalDiffLines = oldLines.length + newLines.length // 16, fully disjoint -> no LCS matches
    const expectedShown = totalDiffLines <= maxDiffLines ? totalDiffLines : Math.max(maxDiffLines - 1, 0)
    const expectedHidden = totalDiffLines - expectedShown

    // (b) Every shown diff line is contiguous and correct: old lines are emitted before
    // new lines for two fully disjoint sides (see diffLines' tie-break), so the leading
    // `expectedShown` lines are exactly the first old lines, in order.
    for (let i = 0; i < Math.min(expectedShown, oldLines.length); i++) {
      expect(frame).toContain(`- ${oldLines[i]}`)
    }
    if (expectedHidden > 0) {
      expect(frame).toContain(`+${expectedHidden} more lines truncated`)
    } else {
      expect(frame).not.toContain('more lines truncated')
    }
    // No diff line beyond what's expected ever silently appears -- a corrupted render
    // would otherwise show a NON-contiguous subset (e.g. skip old-1 but show old-2).
    for (let i = expectedShown; i < oldLines.length; i++) {
      expect(frame).not.toContain(`- ${oldLines[i]}`)
    }
  })
})
