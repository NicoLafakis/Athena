// tests/tui/fullscreen-popup-overflow.test.tsx — the popup half of the fullscreen
// row-budget invariant (the transcript/dialog/todo half lives in app-scroll.test.tsx and
// fullscreen-overflow.test.tsx). Three popups render as UNCLIPPED siblings in the fixed
// height={rows} column: MentionPopup and SlashMenuPopup inside InputBox, ArgPickerPopup
// one level up in App. Each is a bordered box of up to ~11 rows, and each can open while
// a TodoPanel is showing — `todos.length > 0` is entirely independent of `busy`/`pending`,
// so "the picker can't coexist with a dialog or a busy turn" never covered the TodoPanel
// case at all. Before the fix those rows were in no budget anywhere, and the everyday
// sequence "model ran TodoWrite, transcript filled the screen, user typed '@'" pushed the
// frame past the terminal's real row count — which Ink/Yoga corrupts rather than clips.
//
// The invariant every test here asserts is checked against EVERY frame written, not just
// the settled one (see expectEveryFrameSound), and it is about frame CONTENT as much as
// frame height. The root Box is height={rows} and Ink Boxes default to flexShrink: 1, so
// an over-budget layout usually does not produce a taller frame — Yoga shrinks the
// oversized siblings and Ink draws them over one another, leaving a frame that still
// measures exactly `rows` while missing todos, with the banner wordmark fused onto its own
// border rule and the input line struck through a popup's edge. A row-count-only check
// (which is all this file, and app-scroll.test.tsx, used to do) is blind to all of that.
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ReactNode } from 'react'
import { render as inkRender } from 'ink'
import { App, PermissionBridge } from '../../src/tui/App.js'
import { EngineEventBus } from '../../src/engine/events.js'
import type { AgentMentionSource } from '../../src/tui/agentMention.js'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Enough agents that the '@' picker fills its whole window (and then some, so the
 *  "… N more" notice row is in play too) without depending on a real project file walk —
 *  agent rows resolve synchronously, file rows would not (see agentMention.ts). */
const AGENTS: AgentMentionSource[] = Array.from({ length: 14 }, (_, i) => ({
  name: `agent-${String(i + 1).padStart(2, '0')}`,
  description: `does thing number ${i + 1}`,
}))

function makeProps(cwd = 'C:/proj') {
  const bus = new EngineEventBus()
  return {
    bus,
    status: {
      cwd,
      gitBranch: 'main',
      model: 'kimi-k2.7-code',
      modelKey: 'kimi-k2.7-code',
      provider: 'kimi' as const,
      effort: 'high',
      mode: 'normal' as const,
      contextPct: 0,
    },
    onSubmit: vi.fn(async () => {}),
    onSlash: vi.fn(),
    onAbort: vi.fn(),
    permissionBridge: new PermissionBridge(),
    agents: AGENTS,
  }
}

// Same hand-built TTY stream doubles as app-scroll.test.tsx / fullscreen-overflow.test.tsx:
// ink-testing-library's own doubles never set `.isTTY`, so they can't reach fullscreen mode.
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

function renderOnTty(node: ReactNode, rows: number, columns = 80): { stdout: TtyStdout; stdin: TtyStdin } {
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
  return { stdout, stdin }
}

function lastFrame(stdout: TtyStdout): string {
  return stdout.frames.at(-1) ?? ''
}

/** Every frame the app has written since `from`, ignoring any leading repaint that is
 *  byte-identical to `ignore`. That exemption exists for one specific thing: Ink registers
 *  its OWN `stdout.on('resize')` handler at render() time and synchronously re-lays-out and
 *  repaints from the existing React tree the moment a resize fires — before App's
 *  useTerminalSize state update can possibly have landed. Since these tests resize only
 *  `rows` (never `columns`), that repaint reproduces the previous frame exactly, so
 *  matching on equality identifies it precisely rather than blanket-skipping "the first
 *  frame or two". It is Ink's frame, not a budget miss, and nothing in App can pre-empt it.
 */
function framesSince(stdout: TtyStdout, from: number, ignore?: string): { index: number; text: string }[] {
  const all = stdout.frames.slice(from).map((text, i) => ({ index: from + i, text }))
  let start = 0
  while (ignore !== undefined && start < all.length && all[start]?.text === ignore) start += 1
  return all.slice(start)
}

/** Asserts the fullscreen layout invariant against EVERY frame written since `from`, not
 *  just the final settled one. A frame that is wrong for a single render and corrected by
 *  the next has still been written to the real terminal, and the user saw it.
 *
 *  Two distinct failure signatures, because the row-count one alone does NOT catch the
 *  interesting bug. The root Box is `height={rows}` and Ink's Box defaults to
 *  `flexShrink: 1`, so when the unclipped siblings' natural heights sum past `rows`, Yoga
 *  does not push the frame taller — it SHRINKS them, and Ink then draws their content over
 *  each other. The frame still measures exactly `rows` while being visibly destroyed:
 *  every third todo silently dropped, the banner's wordmark fused onto its border row, a
 *  popup's title line overwritten by its first item, the input line drawn across the
 *  popup's bottom border. So the content checks below are the primary detector and the row
 *  count is the backstop for the case where content genuinely does overflow:
 *
 *   - Banner: the wordmark occupies a row of its own, never merged with a border row.
 *   - TodoPanel: the todos shown are always the PREFIX todo-1..todo-N. Interleaved
 *     overwriting drops rows out of the middle of the list, which no correct truncation
 *     (which only ever elides a suffix, behind a "+N more" notice) can produce.
 */
function expectEveryFrameSound(stdout: TtyStdout, rows: number, from = 0, ignore?: string): void {
  const problems: string[] = []
  for (const { index, text } of framesSince(stdout, from, ignore)) {
    const lines = text.split('\n')
    if (lines.length > rows) problems.push(`frame ${index}: ${lines.length} rows > ${rows}`)
    if (text.includes('ATHENA') && !lines.some((l) => l.trimEnd() === '  ATHENA')) {
      problems.push(`frame ${index}: banner wordmark row fused with adjacent chrome`)
    }
    const shown = lines.flatMap((l) => {
      const m = /\btodo-(\d+)\b/.exec(l)
      return m ? [Number(m[1])] : []
    })
    const expected = shown.map((_, i) => i + 1)
    if (shown.length > 0 && String(shown) !== String(expected)) {
      problems.push(`frame ${index}: todo rows are ${shown} — not the contiguous prefix ${expected}`)
    }
  }
  expect(problems, `frames that broke the fullscreen layout invariant on a ${rows}-row terminal`).toEqual([])
}

/** Fills the transcript so the flexible middle region is genuinely competing for rows —
 *  the ordinary state of a fullscreen session, and a precondition for the bug. */
async function seedEntries(bus: EngineEventBus, count: number): Promise<void> {
  for (let i = 1; i <= count; i++) {
    bus.emit({ type: 'info', message: `msg-${i}` })
    await delay(0)
  }
  await delay(20)
}

async function seedTodos(bus: EngineEventBus, count: number): Promise<void> {
  bus.emit({
    type: 'todo-update',
    todos: Array.from({ length: count }, (_, i) => ({ text: `todo-${i + 1}`, status: 'pending' as const })),
  })
  await delay(20)
}

describe('fullscreen popup row budgeting', () => {
  // The regression case for the one-render stale budget (see useInputBox's doc comment).
  // A popup takes the input box from 1 row to ~13 in a SINGLE keystroke; while its height
  // reached App through a post-commit onHeightChange callback, the frame committed by that
  // keystroke sized TodoPanel (and the transcript window) for the OLD 1-row box. It takes a
  // todo list long enough to be TRUNCATED for that to show: with only 4-6 todos the stale
  // budget and the correct one both fit the whole list, which is why every pre-existing
  // case here passed even under an every-frame assertion. 20 todos is the difference
  // between "show 18" (stale) and "show 6" (correct), and the 12 rows of overshoot is what
  // Yoga resolves by shrinking siblings and Ink by drawing them over each other — at an
  // unchanged frame height of exactly `rows`.
  it('a popup opening next to a TRUNCATED TodoPanel corrupts no frame, not even transiently', async () => {
    for (const trigger of ['@', '/']) {
      const rows = 30
      const props = makeProps()
      const { stdout, stdin } = renderOnTty(<App {...props} />, rows, 80)
      await delay(10)
      await seedTodos(props.bus, 20)
      await seedEntries(props.bus, 40)

      const from = stdout.frames.length
      stdin.write(trigger)
      await delay(30)

      // Preconditions: the popup opened, and the panel really is truncating.
      expect(lastFrame(stdout)).toContain(trigger === '@' ? '[agent]' : 'Esc cancel')
      expect(lastFrame(stdout)).toContain('more (widen terminal')
      expectEveryFrameSound(stdout, rows, from)
    }
  })

  it('TodoPanel + @-mention popup: both fit, and the frame stays inside the terminal', async () => {
    const rows = 30
    const props = makeProps()
    const { stdout, stdin } = renderOnTty(<App {...props} />, rows, 80)
    await delay(10)
    await seedTodos(props.bus, 4)
    await seedEntries(props.bus, 40)

    stdin.write('@')
    await delay(30)

    const frame = lastFrame(stdout)
    expect(frame).toContain('[agent]') // the popup really did open
    expect(frame).toContain('todo-1') // and the panel really did stay
    expect(frame).toContain('ATHENA') // pinned header intact
    expect(frame).toContain('C:/proj') // pinned footer intact
    expectEveryFrameSound(stdout, rows)
  })

  it('TodoPanel + slash menu popup stays inside the terminal', async () => {
    const rows = 30
    const props = makeProps()
    const { stdout, stdin } = renderOnTty(<App {...props} />, rows, 80)
    await delay(10)
    await seedTodos(props.bus, 4)
    await seedEntries(props.bus, 40)

    stdin.write('/')
    await delay(30)

    const frame = lastFrame(stdout)
    expect(frame).toContain('Esc cancel') // the slash menu really did open
    expect(frame).toContain('todo-1')
    expect(frame).toContain('ATHENA')
    expectEveryFrameSound(stdout, rows)
  })

  it('TodoPanel + ArgPickerPopup (bare /model) stays inside the terminal', async () => {
    const rows = 30
    const props = makeProps()
    const { stdout, stdin } = renderOnTty(<App {...props} />, rows, 80)
    await delay(10)
    await seedTodos(props.bus, 4)
    await seedEntries(props.bus, 40)

    stdin.write('/model')
    await delay(30)
    stdin.write('\r')
    await delay(30)

    const frame = lastFrame(stdout)
    expect(frame).toContain('Select model') // the picker really did open
    expect(frame).toContain('todo-1')
    expect(frame).toContain('ATHENA')
    expectEveryFrameSound(stdout, rows)
  })

  it('the exact reported repro — TodoPanel + full transcript + a popup on a 20-row terminal', async () => {
    const rows = 20
    for (const trigger of ['@', '/']) {
      const props = makeProps()
      const { stdout, stdin } = renderOnTty(<App {...props} />, rows, 80)
      await delay(10)
      await seedTodos(props.bus, 6)
      await seedEntries(props.bus, 60)

      stdin.write(trigger)
      await delay(30)

      const frame = lastFrame(stdout)
      expect(frame).toContain('ATHENA')
      expect(frame).toContain('C:/proj')
      expectEveryFrameSound(stdout, rows)
    }
  })

  it('a bare /model on a 20-row terminal with todos showing stays inside the terminal', async () => {
    const rows = 20
    const props = makeProps()
    const { stdout, stdin } = renderOnTty(<App {...props} />, rows, 80)
    await delay(10)
    await seedTodos(props.bus, 6)
    await seedEntries(props.bus, 60)

    stdin.write('/model')
    await delay(30)
    stdin.write('\r')
    await delay(30)

    const frame = lastFrame(stdout)
    expect(frame).toContain('Select model')
    expectEveryFrameSound(stdout, rows)
  })

  it('multi-line input (backslash continuation) plus an open popup stays inside the terminal', async () => {
    const rows = 20
    const props = makeProps()
    const { stdout, stdin } = renderOnTty(<App {...props} />, rows, 80)
    await delay(10)
    await seedTodos(props.bus, 4)
    await seedEntries(props.bus, 40)

    // Four backslash-continuations => a five-row text box, then arm the '@' popup on top
    // of it. The height signal has to cover BOTH, which is the part a text-line-only
    // onHeightChange got wrong.
    for (let i = 0; i < 4; i++) {
      stdin.write('a\\')
      await delay(10)
      stdin.write('\r')
      await delay(10)
    }
    stdin.write('@')
    await delay(30)

    const frame = lastFrame(stdout)
    expect(frame).toContain('… a') // the continuation rows really are there
    expect(frame).toContain('C:/proj')
    expectEveryFrameSound(stdout, rows)
  })

  // The ArgPicker's "can't draw" path used to be a dead end rather than a graceful yield:
  // argPicker was set, popupLayout returned null so nothing rendered, but InputBox stayed
  // disabled (its `disabled` includes `argPicker !== null`) and the picker's own key
  // handler stayed armed. The user got a cursorless, unresponsive input box with no visible
  // cause — strictly worse than the '@'/'/' popups, which keep typing working when they
  // step aside. Escape did recover, but nothing on screen said so.
  it('a picker too tall to draw says so and hands the keyboard back, instead of freezing the input', async () => {
    const rows = 8 // no room for a bordered 4-row picker once banner/todos/status are paid
    const props = makeProps()
    const { stdout, stdin } = renderOnTty(<App {...props} />, rows, 80)
    await delay(10)
    await seedTodos(props.bus, 4)
    await seedEntries(props.bus, 20)

    stdin.write('/model')
    await delay(20)
    stdin.write('\r')
    await delay(40)

    // It really couldn't draw...
    expect(lastFrame(stdout)).not.toContain('Select model')
    // ...the user is told why, and told what to do instead...
    expect(lastFrame(stdout)).toContain('Not enough room to show the /model picker')
    // ...and the input box is live again: typing lands, no Escape required.
    stdin.write('hello')
    await delay(30)
    expect(lastFrame(stdout)).toContain('hello')
    expectEveryFrameSound(stdout, rows)
  })

  it('narrow terminal where the status line itself wraps: a popup still cannot overflow', async () => {
    const rows = 20
    const columns = 30
    // A deliberately long cwd so statusLineText wraps to several rows at 30 columns —
    // the budget has to spend those rows before the popup sees any.
    const props = makeProps('C:/a-very-long-project-directory-name/nested/deeper/still')
    const { stdout, stdin } = renderOnTty(<App {...props} />, rows, columns)
    await delay(10)
    await seedTodos(props.bus, 4)
    await seedEntries(props.bus, 40)

    for (const trigger of ['@', '/']) {
      stdin.write('\u001B') // Esc: close whatever the previous iteration opened
      await delay(10)
      stdin.write(trigger)
      await delay(30)
      expectEveryFrameSound(stdout, rows)
      expect(lastFrame(stdout)).toContain('nested')
    }
  })

  it('very short terminal (rows near MIN_TRANSCRIPT_ROWS): popups yield rather than overflow', async () => {
    for (const rows of [4, 5, 6, 8]) {
      const props = makeProps()
      const { stdout, stdin } = renderOnTty(<App {...props} />, rows, 80)
      await delay(10)
      await seedTodos(props.bus, 4)
      await seedEntries(props.bus, 20)

      stdin.write('@')
      await delay(30)
      expectEveryFrameSound(stdout, rows)

      stdin.write('\u001B')
      await delay(10)
      stdin.write('/model')
      await delay(20)
      stdin.write('\r')
      await delay(30)
      expectEveryFrameSound(stdout, rows)
    }
  })

  it('a resize while a popup is open re-budgets it instead of leaving a too-tall frame', async () => {
    const props = makeProps()
    const { stdout, stdin } = renderOnTty(<App {...props} />, 30, 80)
    await delay(10)
    await seedTodos(props.bus, 4)
    await seedEntries(props.bus, 40)

    stdin.write('@')
    await delay(30)
    expect(lastFrame(stdout)).toContain('[agent]')

    for (const rows of [12, 9, 6, 24]) {
      // Frames written BEFORE this step were budgeted against the previous row count, so
      // only the ones from here on are measured against the new one — minus Ink's own
      // synchronous resize repaint of the pre-resize tree (see framesSince).
      const from = stdout.frames.length
      const beforeResize = lastFrame(stdout)
      stdout.rows = rows
      stdout.emit('resize')
      await delay(30)
      expectEveryFrameSound(stdout, rows, from, beforeResize)
      expect(lastFrame(stdout)).toContain('C:/proj') // pinned footer survives every step
    }
  })

  it('a resize while the ArgPicker is open re-budgets it instead of leaving a too-tall frame', async () => {
    const props = makeProps()
    const { stdout, stdin } = renderOnTty(<App {...props} />, 30, 80)
    await delay(10)
    await seedTodos(props.bus, 4)
    await seedEntries(props.bus, 40)

    stdin.write('/model')
    await delay(20)
    stdin.write('\r')
    await delay(30)
    expect(lastFrame(stdout)).toContain('Select model')

    for (const rows of [14, 10, 7, 22]) {
      const from = stdout.frames.length // see the '@' resize case above
      const beforeResize = lastFrame(stdout)
      stdout.rows = rows
      stdout.emit('resize')
      await delay(30)
      expectEveryFrameSound(stdout, rows, from, beforeResize)
    }
  })
})
