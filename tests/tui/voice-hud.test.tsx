import React from 'react'
import { EventEmitter } from 'node:events'
import { render as inkRender } from 'ink'
import { describe, expect, it } from 'vitest'
import { VoiceHud } from '../../src/tui/VoiceHud.js'
import { createInitialVoiceHudState, VoiceHudStore } from '../../src/voice/visualizer.js'

async function waitForFrame(
  stdout: TtyStdout,
  predicate: (frame: string) => boolean,
  timeoutMs = 3000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const frame = stdout.lastFrame()
    if (predicate(frame)) return frame
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
  return stdout.lastFrame()
}

class TtyStdout extends EventEmitter {
  isTTY = true
  frames: string[] = []
  constructor(
    public columns: number,
    public rows: number,
  ) {
    super()
  }
  write = (frame: string): boolean => {
    // Ignore control-only escape sequences (alt-screen enter/exit, cursor hide/show)
    const visible = frame.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').trim()
    if (visible.length > 0) {
      this.frames.push(frame)
    }
    return true
  }
  lastFrame(): string {
    return this.frames[this.frames.length - 1] ?? ''
  }
}

class TtyStdin extends EventEmitter {
  isTTY = true
  data: string | null = null
  setRawMode = () => {}
  setEncoding = () => {}
  resume = () => {}
  pause = () => {}
  ref = () => {}
  unref = () => {}
  read = () => {
    const out = this.data
    this.data = null
    return out
  }
  send(chunk: string): void {
    this.data = chunk
    this.emit('readable')
    this.emit('data', chunk)
  }
}

describe('VoiceHud EEG view toggle (non-conflicting with Ctrl+C)', () => {
  it('toggles between Split EEG and Chat-only on wide terminals with B and Tab', async () => {
    const stdout = new TtyStdout(120, 30)
    const stdin = new TtyStdin()
    const stderr = new TtyStdout(120, 30)
    const store = new VoiceHudStore(
      createInitialVoiceHudState({ model: 'gpt-live-1.1', projectName: 'Athena' }),
    )
    const inst = inkRender(React.createElement(VoiceHud, { store }), {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    })
    try {
      const initial = await waitForFrame(stdout, (f) => f.includes('CONVERSATION'))
      expect(initial).toContain('CONVERSATION')
      expect(initial).toContain('NEURAL SCAN · EEG')
      expect(initial).toContain('Tab/B toggle EEG')
      expect(initial).toContain('Ctrl+C quit')
      expect(initial).not.toContain('Compact view')
      // Allow React's useInput effect to subscribe to stdin after synchronous debug render
      await new Promise((r) => setTimeout(r, 25))

      // Press 'b' -> collapses EEG to chat-only view
      stdin.send('b')
      const chatOnly = await waitForFrame(stdout, (f) => f.includes('Chat only'))
      expect(chatOnly).toContain('CONVERSATION')
      expect(chatOnly).not.toContain('NEURAL SCAN · EEG')
      expect(chatOnly).toContain('Chat only')

      // Press Tab -> restores split EEG view
      stdin.send('\t')
      const restored = await waitForFrame(stdout, (f) => f.includes('EEG split'))
      expect(restored).toContain('CONVERSATION')
      expect(restored).toContain('NEURAL SCAN · EEG')
      expect(restored).toContain('EEG split')
    } finally {
      inst.unmount()
    }
  })

  it('toggles full-pane EEG on narrow terminals (<92 cols) with B without needing to widen or use Ctrl+C', async () => {
    const stdout = new TtyStdout(80, 26)
    const stdin = new TtyStdin()
    const stderr = new TtyStdout(80, 26)
    const store = new VoiceHudStore(
      createInitialVoiceHudState({ model: 'gpt-live-1.1', projectName: 'Athena' }),
    )
    const inst = inkRender(React.createElement(VoiceHud, { store }), {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    })
    try {
      const initial = await waitForFrame(stdout, (f) => f.includes('CONVERSATION'))
      expect(initial).toContain('CONVERSATION')
      expect(initial).not.toContain('NEURAL SCAN · EEG')
      expect(initial).toContain('EEG')
      expect(initial).toContain('Ctrl+C quit')
      await new Promise((r) => setTimeout(r, 25))

      // Press 'b' -> opens full-pane EEG even on narrow terminal
      stdin.send('b')
      const eegFull = await waitForFrame(stdout, (f) => f.includes('EEG full'))
      expect(eegFull).toContain('NEURAL SCAN · EEG')
      expect(eegFull).not.toContain('CONVERSATION')
      expect(eegFull).toContain('EEG full')

      // Press 'b' again -> returns to conversation view
      stdin.send('b')
      const backToChat = await waitForFrame(stdout, (f) => f.includes('CONVERSATION'))
      expect(backToChat).toContain('CONVERSATION')
      expect(backToChat).not.toContain('NEURAL SCAN · EEG')
    } finally {
      inst.unmount()
    }
  })

  it('splits the right pane 50/50 with 3D EEG on top and a bounded Running Agent Ledger underneath (20-agent overflow safe)', async () => {
    const stdout = new TtyStdout(120, 26)
    const stdin = new TtyStdin()
    const stderr = new TtyStdout(120, 26)
    const store = new VoiceHudStore(
      createInitialVoiceHudState({ model: 'gpt-live-1.1', projectName: 'Athena' }),
    )
    store.dispatch({
      type: 'agents-sync',
      agents: Array.from({ length: 20 }, (_, i) => ({
        name: `agent-${i + 1}`,
        description: `Specialist worker #${i + 1}`,
      })),
    })
    store.dispatch({
      type: 'engine-event',
      now: Date.now() - 2_000,
      event: {
        type: 'tool-request',
        id: 'tc_1',
        name: 'Agent',
        input: { agent: 'agent-7', prompt: 'Auditing API routes' },
      },
    })

    const inst = inkRender(React.createElement(VoiceHud, { store }), {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    })
    try {
      const frame = await waitForFrame(stdout, (f) => f.includes('AGENT LEDGER'))
      expect(frame).toContain('NEURAL SCAN · EEG')
      expect(frame).toContain('AGENT LEDGER')
      expect(frame).toContain('1 ACTIVE')
      // Active agent pinned at top with task
      expect(frame).toContain('agent-7')
      expect(frame).toContain('Auditing API routes')
      // Overflow indicator bounds the 20 idle agents cleanly inside the row budget
      expect(frame).toMatch(/\+\d+ more idle/)
    } finally {
      inst.unmount()
    }
  })
})
