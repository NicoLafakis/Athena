import { describe, it, expect } from 'vitest'
import { HookRunner } from '../../src/harness/hooks.js'
import type { HookDef } from '../../src/brain/settings.js'

const node = process.execPath
function hook(partial: Partial<HookDef> & Pick<HookDef, 'event' | 'command'>): HookDef {
  return { timeoutMs: 5_000, ...partial }
}

describe('HookRunner', () => {
  it('exit 0 allows and stdout JSON annotates context', async () => {
    const runner = new HookRunner([
      hook({
        event: 'PreToolUse',
        command: `"${node}" -e "console.log(JSON.stringify({addedContext:'from-hook'}));process.exit(0)"`,
      }),
    ])
    const out = await runner.run('PreToolUse', { toolName: 'Bash', input: { command: 'git status' } })
    expect(out.allowed).toBe(true)
    expect(out.addedContext).toBe('from-hook')
  })

  it('exit 2 denies with stderr as reason', async () => {
    const runner = new HookRunner([
      hook({
        event: 'PreToolUse',
        command: `"${node}" -e "console.error('blocked by gate');process.exit(2)"`,
      }),
    ])
    const out = await runner.run('PreToolUse', { toolName: 'Bash', input: { command: 'rm -rf' } })
    expect(out.allowed).toBe(false)
    expect(out.reason).toContain('blocked by gate')
  })

  it('hook receives the event JSON on stdin', async () => {
    const runner = new HookRunner([
      hook({
        event: 'PreToolUse',
        command: `"${node}" -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const e=JSON.parse(d);process.exit(e.toolName==='Edit'?2:0)})"`,
      }),
    ])
    expect((await runner.run('PreToolUse', { toolName: 'Edit', input: {} })).allowed).toBe(false)
    expect((await runner.run('PreToolUse', { toolName: 'Read', input: {} })).allowed).toBe(true)
  })

  it('PreToolUse process failure (crash/timeout/bad exit) fails CLOSED', async () => {
    const crash = new HookRunner([hook({ event: 'PreToolUse', command: `"${node}" -e "process.exit(1)"` })])
    expect((await crash.run('PreToolUse', { toolName: 'Bash', input: {} })).allowed).toBe(false)
    const timeout = new HookRunner([
      hook({ event: 'PreToolUse', timeoutMs: 300, command: `"${node}" -e "setTimeout(()=>{},60000)"` }),
    ])
    expect((await timeout.run('PreToolUse', { toolName: 'Bash', input: {} })).allowed).toBe(false)
  })

  it('non-PreToolUse process failure fails OPEN with a warning reason', async () => {
    const runner = new HookRunner([hook({ event: 'PostToolUse', command: `"${node}" -e "process.exit(1)"` })])
    const out = await runner.run('PostToolUse', { toolName: 'Bash', input: {} })
    expect(out.allowed).toBe(true)
    expect(out.reason).toMatch(/hook failed/i)
  })

  it('matcher restricts a hook to matching tools; * matches all', async () => {
    const runner = new HookRunner([
      hook({
        event: 'PreToolUse',
        matcher: 'Bash',
        command: `"${node}" -e "process.exit(2)"`,
      }),
    ])
    expect((await runner.run('PreToolUse', { toolName: 'Bash', input: {} })).allowed).toBe(false)
    expect((await runner.run('PreToolUse', { toolName: 'Read', input: {} })).allowed).toBe(true)
  })

  it('no hooks registered for an event -> allowed', async () => {
    expect((await new HookRunner([]).run('Stop', {})).allowed).toBe(true)
  })

  it('hook that destroys stdin before the payload write completes does not crash the runner', async () => {
    const runner = new HookRunner([
      hook({
        event: 'PreToolUse',
        command: `"${node}" -e "process.stdin.destroy();setTimeout(()=>process.exit(0),100)"`,
      }),
    ])
    // Large payload so the stdin write is still in flight when the hook destroys its end.
    const bigInput = { blob: 'x'.repeat(1_000_000) }
    const out = await runner.run('PreToolUse', { toolName: 'Bash', input: bigInput })
    expect(out.allowed).toBe(true)
  })
})
