import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  LineInputCancelledError,
  ReadlineLineInput,
} from '../../src/presentation/line-input.js'

describe('ReadlineLineInput', () => {
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
