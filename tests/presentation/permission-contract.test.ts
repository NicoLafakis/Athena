import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createAccessiblePermissionRequest } from '../../src/presentation/permission-format.js'
import { ScreenReaderPresentation } from '../../src/presentation/screen-reader.js'
import { ReadlineLineInput } from '../../src/presentation/line-input.js'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))

describe('inspectable fresh consent', () => {
  it('exposes complete long arguments with cwd and exact session grant, safely', () => {
    const request = createAccessiblePermissionRequest({
      id: 'p1', toolName: 'PowerShell', cwd: process.cwd(),
      input: { command: `echo ${'x'.repeat(5000)} distinguishing-end\u001b[2J`, token: 'secret-value' },
      summary: 'Run command', reason: 'Policy asks',
    })
    expect(request.details).toContain('distinguishing-end')
    expect(request.details).toContain(process.cwd())
    expect(request.details).toContain('PowerShell(echo:*)')
    expect(request.details).toContain('[REDACTED]')
    expect(request.details).not.toContain('secret-value')
    expect(request.details).not.toContain('\u001b')
  })

  it('opens details without resolving and cannot consume pre-prompt consent', async () => {
    const source = new PassThrough()
    const input = new ReadlineLineInput(source, new PassThrough())
    const chunks: string[] = []
    const presentation = new ScreenReaderPresentation({ input, write: value => chunks.push(value) })
    source.write('y\n')
    await tick()
    let settled = false
    const pending = presentation.requestPermission(createAccessiblePermissionRequest({
      id: 'p2', toolName: 'PowerShell', cwd: process.cwd(),
      input: { command: `echo ${'x'.repeat(5000)} distinguishing-end` },
      summary: 'Run command', reason: 'Policy asks',
    })).then(answer => { settled = true; return answer })
    await tick()
    expect(settled).toBe(false)
    source.write('/details permission p2\n')
    await tick()
    expect(chunks.join('')).toContain('distinguishing-end')
    expect(settled).toBe(false)
    source.write('n\n')
    await expect(pending).resolves.toBe('deny')
    input.close()
  })
})
