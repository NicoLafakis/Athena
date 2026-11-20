import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicWriteFileSync } from '../../src/tools/files.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'athena-atomic-write-'))
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('atomicWriteFileSync validation', () => {
  it('keeps the previous file when temporary replacement validation fails', () => {
    const file = join(root, 'state.json')
    writeFileSync(file, 'previous', 'utf8')

    expect(() => atomicWriteFileSync(file, 'replacement', (content) => {
      if (content !== 'expected') throw new Error('replacement validation failed')
    })).toThrow(/replacement validation failed/)

    expect(readFileSync(file, 'utf8')).toBe('previous')
  })

  it('replaces the file after temporary content validation succeeds', () => {
    const file = join(root, 'state.json')
    writeFileSync(file, 'previous', 'utf8')

    atomicWriteFileSync(file, 'replacement', (content) => {
      if (content !== 'replacement') throw new Error('unexpected replacement')
    })

    expect(readFileSync(file, 'utf8')).toBe('replacement')
  })
})
