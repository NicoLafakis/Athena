import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render } from 'ink-testing-library'
import { PermissionDialog } from '../../src/tui/components/PermissionDialog.js'
import type { PendingPermission } from '../../src/tui/App.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'athena-permdialog-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function pendingFor(toolName: string, input: unknown): PendingPermission {
  return {
    toolName,
    input,
    summary: `${toolName}(${JSON.stringify(input).slice(0, 60)})`,
    reason: 'mutating tool',
    resolve: vi.fn(),
  }
}

describe('PermissionDialog diff preview', () => {
  it('Write over an existing file shows removed and added lines', () => {
    writeFileSync(join(dir, 'f.txt'), 'old line', 'utf8')
    const pending = pendingFor('Write', { file_path: 'f.txt', content: 'new line' })
    const { lastFrame } = render(<PermissionDialog pending={pending} cwd={dir} />)
    expect(lastFrame()).toContain('- old line')
    expect(lastFrame()).toContain('+ new line')
  })

  it('Write of a NEW file shows all lines as additions', () => {
    const pending = pendingFor('Write', { file_path: 'brand-new.txt', content: 'alpha\nbeta' })
    const { lastFrame } = render(<PermissionDialog pending={pending} cwd={dir} />)
    expect(lastFrame()).toContain('+ alpha')
    expect(lastFrame()).toContain('+ beta')
    expect(lastFrame()).not.toContain('- ')
  })

  it('Edit shows old_string vs new_string as a diff', () => {
    const pending = pendingFor('Edit', {
      file_path: 'f.txt',
      old_string: 'const a = 1',
      new_string: 'const a = 2',
    })
    const { lastFrame } = render(<PermissionDialog pending={pending} cwd={dir} />)
    expect(lastFrame()).toContain('- const a = 1')
    expect(lastFrame()).toContain('+ const a = 2')
  })

  it('non-file tools keep the plain summary dialog (no diff lines)', () => {
    const pending = pendingFor('Bash', { command: 'git push' })
    const { lastFrame } = render(<PermissionDialog pending={pending} cwd={dir} />)
    expect(lastFrame()).toContain('git push')
    expect(lastFrame()).toMatch(/allow once/i)
    expect(lastFrame()).not.toContain('+ ')
    expect(lastFrame()).not.toContain('- ')
  })

  it('answer keys still resolve', async () => {
    const pending = pendingFor('Write', { file_path: 'f.txt', content: 'x' })
    const { stdin } = render(<PermissionDialog pending={pending} cwd={dir} />)
    await new Promise((r) => setTimeout(r, 0)) // let useInput attach
    stdin.write('y')
    expect(pending.resolve).toHaveBeenCalledWith('allow-once')
  })
})
