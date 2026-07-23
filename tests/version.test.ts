import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getVersion } from '../src/version.js'

describe('getVersion', () => {
  it('reads the real version out of package.json (not undefined, not the 0.0.0 fallback)', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      version: string
    }
    expect(getVersion()).toBe(pkg.version)
  })

  it('caches the result across calls (module-level constant, not re-read per call)', () => {
    expect(getVersion()).toBe(getVersion())
  })
})
