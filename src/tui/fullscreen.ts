// src/tui/fullscreen.ts — alternate-screen buffer control for the fullscreen TUI mode
// (`/tui fullscreen` / `/tui classic`, see slash.ts; fullscreen is the default on a real
// TTY, classic the fallback elsewhere and the opt-out — see App.tsx). Same escape
// sequences vim/htop use to swap to a private buffer instead of the terminal's native
// scrollback. Classic mode never touches this file.

/** DECSET/DECRST 1049: swap to/from the terminal's alternate screen buffer. */
export const ALT_SCREEN_ENTER = '\x1b[?1049h'
export const ALT_SCREEN_EXIT = '\x1b[?1049l'

/** Basic X10 mouse reporting (click + wheel). Exported for completeness/documentation;
 *  NOT wired up to stdin parsing — see the "deferred" note in App.tsx's fullscreen effect
 *  for why (Ink owns the stdin stream and there's no seam to safely intercept raw mouse
 *  escape sequences without fighting Ink's own input consumption). */
export const MOUSE_TRACKING_ENABLE = '\x1b[?1000h'
export const MOUSE_TRACKING_DISABLE = '\x1b[?1000l'

export interface FullscreenController {
  readonly active: boolean
  /** True when this controller is bound to a real TTY and can actually switch buffers.
   *  Callers must gate entry on this — off a real TTY (piped output, tests, CI) fullscreen
   *  must stay a non-fatal no-op, never throw. */
  readonly supported: boolean
  enter(): void
  exit(): void
  /** Unregisters this controller from the process-wide exit/signal handlers below. Call
   *  on component unmount so short-lived controllers (tests, a picker screen) don't
   *  accumulate forever in a long-running process. */
  dispose(): void
}

// Process-wide restore callbacks, registered once at module scope rather than per
// controller instance — so the App component remounting (tests, a resumed session)
// never stacks up duplicate process listeners, and a crash/Ctrl+C/SIGTERM anywhere
// restores every live controller's screen, not just the most recently created one.
const restoreCallbacks = new Set<() => void>()
let handlersInstalled = false

function installProcessHandlersOnce(): void {
  if (handlersInstalled) return
  handlersInstalled = true
  const restoreAll = () => {
    for (const cb of restoreCallbacks) cb()
  }
  // Covers the normal paths: /quit and Ctrl+C both unmount the Ink tree, which resolves
  // instance.waitUntilExit() in cli.ts's main() and lets the process drain and exit
  // naturally — 'exit' fires right before that, and only synchronous work is allowed
  // in the handler, which a raw stdout.write satisfies.
  process.on('exit', restoreAll)
  // Defensive fallback: some terminals/hosts still deliver a real SIGINT/SIGTERM even
  // though Ink's raw-mode Ctrl+C handling normally intercepts ^C as input data, not a
  // signal. Must never leave the user's terminal stuck on the alternate screen.
  process.on('SIGINT', () => {
    restoreAll()
    process.exit(130)
  })
  process.on('SIGTERM', () => {
    restoreAll()
    process.exit(143)
  })
}

/** Creates a controller bound to one write stream (normally `process.stdout`, or Ink's
 *  injected test double). Every write is guarded behind `stream.isTTY` so non-interactive
 *  contexts (vitest, piped output, CI) silently stay in classic mode instead of writing
 *  raw escape codes into a stream that isn't a terminal. */
export function createFullscreenController(
  stream: NodeJS.WriteStream = process.stdout,
): FullscreenController {
  let active = false
  const supported = Boolean(stream.isTTY)

  const restore = () => {
    if (active && supported) stream.write(ALT_SCREEN_EXIT)
    active = false
  }
  restoreCallbacks.add(restore)
  installProcessHandlersOnce()

  return {
    get active() {
      return active
    },
    supported,
    enter() {
      if (active || !supported) return // non-fatal no-op off a real TTY
      stream.write(ALT_SCREEN_ENTER)
      active = true
    },
    exit() {
      restore()
    },
    dispose() {
      restore()
      restoreCallbacks.delete(restore)
    },
  }
}
