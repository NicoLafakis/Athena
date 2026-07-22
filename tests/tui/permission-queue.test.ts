import { describe, it, expect } from 'vitest'
import { PermissionBridge, type PendingPermission } from '../../src/tui/App.js'

function req(name: string) {
  return { toolName: name, input: {}, summary: `${name}()`, reason: 'test' }
}

describe('PermissionBridge concurrent-ask queue', () => {
  it('queues a second ask while one is pending and presents them one at a time, in order', async () => {
    const shown: Array<PendingPermission | null> = []
    const bridge = new PermissionBridge()
    bridge.bind((p) => shown.push(p))

    const first = bridge.ask(req('Bash'))
    const second = bridge.ask(req('Write'))

    // Only the first is presented; the second must not clobber it.
    expect(shown).toHaveLength(1)
    expect(shown[0]?.toolName).toBe('Bash')

    shown[0]!.resolve('allow-once')
    expect(await first).toBe('allow-once')

    // Now the queued ask is presented.
    const current = shown.at(-1)
    expect(current?.toolName).toBe('Write')

    current!.resolve('deny')
    expect(await second).toBe('deny')

    // Dialog cleared after the queue drains.
    expect(shown.at(-1)).toBeNull()
  })

  it('still fails safe to deny when unbound', async () => {
    const bridge = new PermissionBridge()
    await expect(bridge.ask(req('Bash'))).resolves.toBe('deny')
  })
})
