import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render } from 'ink-testing-library'
import { InputBox } from '../../src/tui/components/InputBox.js'

const UP = '[A'
const DOWN = '[B'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'athena-inputbox-mention-'))
  mkdirSync(join(dir, 'nested'), { recursive: true })
  // Alphabetical order matters for these assertions: alpha.ts < beta.ts < nested/gamma.ts.
  writeFileSync(join(dir, 'alpha.ts'), 'export const alpha = 1', 'utf8')
  writeFileSync(join(dir, 'beta.ts'), 'export const beta = 2', 'utf8')
  writeFileSync(join(dir, 'nested', 'gamma.ts'), 'export const gamma = 3', 'utf8')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('InputBox @-mention autocomplete', () => {
  it('typing @ enters mention mode and lists project files', async () => {
    const onSubmit = vi.fn()
    const { lastFrame, stdin } = render(<InputBox onSubmit={onSubmit} disabled={false} cwd={dir} />)
    await delay(50) // let the background file walk resolve
    stdin.write('@')
    await delay(10)
    const frame = lastFrame()!
    expect(frame).toContain('alpha.ts')
    expect(frame).toContain('beta.ts')
  })

  it('arrow-key navigation moves the highlight so a different entry gets selected', async () => {
    const onSubmit = vi.fn()
    const { stdin } = render(<InputBox onSubmit={onSubmit} disabled={false} cwd={dir} />)
    await delay(50)
    stdin.write('@')
    await delay(10)
    // Empty-query ranking is alphabetical: [alpha.ts, beta.ts, nested/gamma.ts, ...].
    // Highlight starts at index 0 (alpha.ts); one Down moves it to index 1 (beta.ts).
    stdin.write(DOWN)
    await delay(10)
    stdin.write('\t') // Tab confirms the highlighted entry
    await delay(10)
    stdin.write('\r') // submit the turn
    await delay(10)
    expect(onSubmit).toHaveBeenCalledTimes(1)
    const submitted = onSubmit.mock.calls[0]![0] as string
    expect(submitted).toContain('@beta.ts')
    expect(submitted).not.toContain('@alpha.ts')
    expect(submitted).toContain('export const beta = 2')
  })

  it('Up then Down cancel out, leaving the top match selected', async () => {
    const onSubmit = vi.fn()
    const { stdin } = render(<InputBox onSubmit={onSubmit} disabled={false} cwd={dir} />)
    await delay(50)
    stdin.write('@')
    await delay(10)
    stdin.write(UP) // already at index 0, clamps
    await delay(5)
    stdin.write(DOWN)
    await delay(5)
    stdin.write(UP) // back to index 0
    await delay(5)
    stdin.write('\t')
    await delay(10)
    stdin.write('\r')
    await delay(10)
    const submitted = onSubmit.mock.calls[0]![0] as string
    expect(submitted).toContain('@alpha.ts')
  })

  it('Escape cancels mention mode and returns to normal typing', async () => {
    const onSubmit = vi.fn()
    const { lastFrame, stdin } = render(<InputBox onSubmit={onSubmit} disabled={false} cwd={dir} />)
    await delay(50)
    stdin.write('@alpha')
    await delay(10)
    expect(lastFrame()).toContain('alpha.ts') // popup open, filtered to alpha.ts
    stdin.write('') // Escape
    await delay(10)
    // Typed text survives as plain literal text; popup is gone.
    expect(lastFrame()).toContain('@alpha')
    stdin.write(' more text')
    await delay(10)
    stdin.write('\r')
    await delay(10)
    expect(onSubmit).toHaveBeenCalledWith('@alpha more text')
  })

  it('a space while filtering ends mention mode without selecting anything', async () => {
    const onSubmit = vi.fn()
    const { lastFrame, stdin } = render(<InputBox onSubmit={onSubmit} disabled={false} cwd={dir} />)
    await delay(50)
    stdin.write('@nomatchxyz')
    await delay(10)
    stdin.write(' ')
    await delay(10)
    expect(lastFrame()).not.toContain('Tab/Enter confirm') // popup closed
    stdin.write('\r')
    await delay(10)
    expect(onSubmit).toHaveBeenCalledWith('@nomatchxyz ')
  })
})
