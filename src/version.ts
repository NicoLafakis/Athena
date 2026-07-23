// src/version.ts — reads the package's own version at runtime (startup banner, --help,
// etc). `import.meta.url` resolves relative to whichever file is actually executing this
// code: after `pnpm build` that's the tsup bundle at dist/cli.js (this module gets inlined
// into that single-file bundle, so its import.meta.url IS the bundle's own path, not this
// source file's), and under `tsx src/cli.ts` in dev it's this file's own src/ path. Both
// dist/ and src/ sit exactly one directory below the package root, so '../package.json'
// finds the real file either way — no tsup `define`/injection step needed. Verified by
// running the built dist/cli.js and confirming a real (non-undefined) version string
// renders in the fullscreen banner.
import { readFileSync } from 'node:fs'

let cached: string | null = null

/** Package version for display (startup banner). Falls back to '0.0.0' rather than
 *  throwing if package.json is ever missing/unreadable/malformed post-build — a cosmetic
 *  banner field must never be able to crash startup. */
export function getVersion(): string {
  if (cached !== null) return cached
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    const pkg = JSON.parse(raw) as { version?: unknown }
    cached = typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : '0.0.0'
  } catch {
    cached = '0.0.0'
  }
  return cached
}
