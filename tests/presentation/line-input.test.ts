import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  LineInputCancelledError,
  ReadlineLineInput,
} from '../../src/presentation/line-input.js'

describe('ReadlineLineInput', () => {
  it('does not let a pre-consent partial draft or its pasted remainder answer consent', async () => {
    const source = new PassThrough()
    const input = new ReadlineLineInput(source, new PassThrough())
    source.write('y')
    await new Promise<void>((resolve) => setImmediate(resolve))
    let settled = false
    const answer = input.readConsent('Permission: ').then(value => { settled = true; return value })
    source.write('\ny\n')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
    source.write('n\n')
    await expect(answer).resolves.toBe('n')
    input.close()
  })

  it('quarantines a partial remainder across chunks and retains ordinary prompt buffering', async () => {
    const source = new PassThrough()
    const input = new ReadlineLineInput(source, new PassThrough())
    source.write('draft')
    const answer = input.readConsent('Permission: ')
    let settled = false
    void answer.then(() => { settled = true })
    source.write('\ny')
    source.write('\n')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
    source.write('n\nnext prompt\n')
    await expect(answer).resolves.toBe('n')
    await expect(input.readLine('You: ')).resolves.toBe('next prompt')
    input.close()
  })

  it('buffers redirected lines that arrive before the first prompt', async () => {
    const source = new PassThrough()
    const output = new PassThrough()
    const input = new ReadlineLineInput(source, output)
    source.write('early line\n')
    await new Promise<void>((resolve) => setImmediate(resolve))
    await expect(input.readLine('You: ')).resolves.toBe('early line')
    input.close()
  })

  it('cancels one active read and remains usable for the next prompt', async () => {
    const source = new PassThrough()
    const output = new PassThrough()
    const input = new ReadlineLineInput(source, output)
    const interrupted = input.readLine('Permission choice: ')
    expect(input.cancelRead()).toBe(true)
    await expect(interrupted).rejects.toBeInstanceOf(LineInputCancelledError)

    const resumed = input.readLine('You: ')
    source.write('continue\n')
    await expect(resumed).resolves.toBe('continue')
    input.close()
  })
})
