import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveBrainPaths } from '../../src/brain/paths.js'
import { importBrain } from '../../src/brain/import.js'

let home: string
let proj: string
let src: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'athena-home-'))
  proj = mkdtempSync(join(tmpdir(), 'athena-proj-'))
  src = mkdtempSync(join(tmpdir(), 'ares-src-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(proj, { recursive: true, force: true })
  rmSync(src, { recursive: true, force: true })
})

function buildAresFixture(dir: string): void {
  mkdirSync(join(dir, 'memory'), { recursive: true })
  mkdirSync(join(dir, 'skills', 'sop'), { recursive: true })
  mkdirSync(join(dir, 'agents'), { recursive: true })
  writeFileSync(
    join(dir, 'ARES.md'),
    '# Ares Constitution\n\nI am Ares. Ares follows rules.\n\n```bash\necho "Ares stays literal in code blocks"\n```\n\nCaresses and Aresian are not whole words.\n'
  )
  writeFileSync(
    join(dir, 'memory', 'MEMORY.md'),
    '# Memory Index\n- [fact](fact.md) — Ares learned this\n'
  )
  writeFileSync(
    join(dir, 'memory', 'fact.md'),
    '---\nname: Ares core fact\ndescription: How Ares handles commits\n---\nThe body mentions Ares and stays untouched outside frontmatter.\n'
  )
  writeFileSync(
    join(dir, 'skills', 'sop', 'SKILL.md'),
    '---\nname: sop\ndescription: gate\n---\nbody\n'
  )
  writeFileSync(join(dir, 'agents', 'scout.md'), '---\nname: scout\ndescription: scout\n---\nbody\n')
}

describe('importBrain', () => {
  it('copies memory, skills, agents, and constitution into the target brain', async () => {
    buildAresFixture(src)
    const report = await importBrain({
      sourceDir: src,
      paths: resolveBrainPaths({ cwd: proj, homeOverride: home }),
      force: false,
    })
    expect(existsSync(join(home, '.athena', 'ATHENA.md'))).toBe(true)
    expect(existsSync(join(home, '.athena', 'memory', 'fact.md'))).toBe(true)
    expect(existsSync(join(home, '.athena', 'skills', 'sop', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(home, '.athena', 'agents', 'scout.md'))).toBe(true)
    expect(report.copied.length).toBeGreaterThanOrEqual(5)
  })

  it('rewrites whole-word Ares->Athena in the constitution but NOT inside code blocks or partial words', async () => {
    buildAresFixture(src)
    await importBrain({
      sourceDir: src,
      paths: resolveBrainPaths({ cwd: proj, homeOverride: home }),
      force: false,
    })
    const constitution = readFileSync(join(home, '.athena', 'ATHENA.md'), 'utf8')
    expect(constitution).toContain('I am Athena. Athena follows rules.')
    expect(constitution).toContain('echo "Ares stays literal in code blocks"')
    expect(constitution).toContain('Caresses and Aresian')
  })

  it('rewrites memory frontmatter name/description lines only, leaving bodies alone', async () => {
    buildAresFixture(src)
    await importBrain({
      sourceDir: src,
      paths: resolveBrainPaths({ cwd: proj, homeOverride: home }),
      force: false,
    })
    const fact = readFileSync(join(home, '.athena', 'memory', 'fact.md'), 'utf8')
    expect(fact).toContain('name: Athena core fact')
    expect(fact).toContain('description: How Athena handles commits')
    expect(fact).toContain('The body mentions Ares and stays untouched')
  })

  it('writes an import report listing copied, rewritten, and flagged files', async () => {
    buildAresFixture(src)
    const report = await importBrain({
      sourceDir: src,
      paths: resolveBrainPaths({ cwd: proj, homeOverride: home }),
      force: false,
    })
    const reportFile = join(home, '.athena', 'import-report.md')
    expect(existsSync(reportFile)).toBe(true)
    expect(report.rewritten).toContain('ATHENA.md')
    // body still mentions Ares -> manual review
    expect(report.flagged.some((f) => f.file === 'memory/fact.md')).toBe(true)
  })

  it('refuses when target memory is non-empty unless force', async () => {
    buildAresFixture(src)
    mkdirSync(join(home, '.athena', 'memory'), { recursive: true })
    writeFileSync(join(home, '.athena', 'memory', 'existing.md'), 'x')
    const paths = resolveBrainPaths({ cwd: proj, homeOverride: home })
    await expect(importBrain({ sourceDir: src, paths, force: false })).rejects.toThrow(/non-empty/)
    await expect(importBrain({ sourceDir: src, paths, force: true })).resolves.toBeTruthy()
  })
})
