// src/tui/sync-stdout.ts — DEC Mode 2026 Synchronized Output wrapper for zero-flicker Ink rendering.

export const SYNC_OUTPUT_START = '\x1b[?2026h'
export const SYNC_OUTPUT_END = '\x1b[?2026l'

/**
 * Wraps a TTY WriteStream so every frame write is bracketed in DEC Mode 2026
 * (`\x1b[?2026h` ... `\x1b[?2026l`). Supported natively by Windows Terminal,
 * VS Code, Ghostty, Kitty, WezTerm, and Alacritty, telling the terminal emulator
 * to paint the entire frame atomically on VSync with zero tearing or flicker.
 */
export function createSyncStdout(target: NodeJS.WriteStream): NodeJS.WriteStream {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop === 'write') {
        return (
          chunk: string | Uint8Array,
          encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
          cb?: (err?: Error | null) => void,
        ): boolean => {
          if (!obj.isTTY) {
            return obj.write(chunk, encodingOrCb as BufferEncoding, cb)
          }
          const str = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
          if (str.length === 0 || str.includes(SYNC_OUTPUT_START)) {
            return obj.write(chunk, encodingOrCb as BufferEncoding, cb)
          }
          const wrapped = `${SYNC_OUTPUT_START}${str}${SYNC_OUTPUT_END}`
          return obj.write(wrapped, encodingOrCb as BufferEncoding, cb)
        }
      }
      const value = Reflect.get(obj, prop, receiver)
      return typeof value === 'function' ? value.bind(obj) : value
    },
  })
}
