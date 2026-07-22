import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assembleSystemPrompt, findProjectContextFiles } from '../../src/engine/prompt.js'

describe('assembleSystemPrompt', () => {
  it('assembles sections in spec order: constitution, memory index, project context, tool guidance, environment', () => {
    const prompt = assembleSystemPrompt({
      constitution: '# ATHENA\nI am Athena.',
      memoryIndex: '# Memory Index\n- [x](x.md) — fact',
      projectContext: [{ file: 'C:/proj/CLAUDE.md', content: 'Project rules' }],
      toolGuidance: 'Use Read before Edit.',
      skills: [],
      environment: { cwd: 'C:/proj', platform: 'win32', gitBranch: 'main', date: '2026-07-21' },
    })
    const order = ['I am Athena', 'Memory Index', 'Project rules', 'Use Read before Edit', 'cwd: C:/proj']
    const positions = order.map((s) => prompt.indexOf(s))
    expect(positions.every((p) => p >= 0)).toBe(true)
    expect([...positions]).toEqual([...positions].sort((a, b) => a - b))
  })

  it('omits absent sections without leaving empty headers', () => {
    const prompt = assembleSystemPrompt({
      constitution: null,
      memoryIndex: null,
      projectContext: [],
      toolGuidance: '',
      skills: [],
      environment: { cwd: 'C:/proj', platform: 'win32', gitBranch: null, date: '2026-07-21' },
    })
    expect(prompt).not.toContain('# Memory')
    expect(prompt).not.toContain('# Project context')
    expect(prompt).not.toContain('# Tool guidance')
    expect(prompt).toContain('# Environment')
    expect(prompt).toContain('git branch: (not a git repo)')
  })

  it('includes all environment fields', () => {
    const prompt = assembleSystemPrompt({
      constitution: null,
      memoryIndex: null,
      projectContext: [],
      toolGuidance: '',
      skills: [],
      environment: { cwd: 'C:/proj', platform: 'win32', gitBranch: 'main', date: '2026-07-21' },
    })
    expect(prompt).toContain('cwd: C:/proj')
    expect(prompt).toContain('platform: win32')
    expect(prompt).toContain('git branch: main')
    expect(prompt).toContain('date: 2026-07-21')
  })

  it('renders a # Skills section listing skill names when the skills array is non-empty', () => {
    const prompt = assembleSystemPrompt({
      constitution: null,
      memoryIndex: null,
      projectContext: [],
      toolGuidance: 'Use Read before Edit.',
      skills: [
        { name: 'commit-flow', description: 'Review and commit cleanly' },
        { name: 'explorer', description: 'Find things' },
      ],
      environment: { cwd: 'C:/proj', platform: 'win32', gitBranch: 'main', date: '2026-07-21' },
    })
    expect(prompt).toContain('# Skills')
    expect(prompt).toContain('- commit-flow — Review and commit cleanly')
    expect(prompt).toContain('- explorer — Find things')
    // Placement: after tool guidance, before environment.
    expect(prompt.indexOf('Use Read before Edit')).toBeLessThan(prompt.indexOf('# Skills'))
    expect(prompt.indexOf('# Skills')).toBeLessThan(prompt.indexOf('# Environment'))
  })

  it('omits the # Skills section when the skills array is empty', () => {
    const prompt = assembleSystemPrompt({
      constitution: null,
      memoryIndex: null,
      projectContext: [],
      toolGuidance: '',
      skills: [],
      environment: { cwd: 'C:/proj', platform: 'win32', gitBranch: null, date: '2026-07-21' },
    })
    expect(prompt).not.toContain('# Skills')
  })
})

describe('findProjectContextFiles', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'athena-prompt-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('walks up from cwd collecting CLAUDE.md / AGENTS.md / ATHENA.md, nearest last', () => {
    const sub = join(root, 'sub')
    mkdirSync(sub)
    writeFileSync(join(root, 'CLAUDE.md'), 'root rules')
    writeFileSync(join(sub, 'AGENTS.md'), 'sub rules')
    const found = findProjectContextFiles(sub).filter((f) => f.file.startsWith(root))
    expect(found).toEqual([
      { file: join(root, 'CLAUDE.md'), content: 'root rules' },
      { file: join(sub, 'AGENTS.md'), content: 'sub rules' },
    ])
  })

  it('returns empty array when no context files exist', () => {
    const found = findProjectContextFiles(root).filter((f) => f.file.startsWith(root))
    expect(found).toEqual([])
  })

  it('collects multiple context file names in the same directory', () => {
    writeFileSync(join(root, 'CLAUDE.md'), 'a')
    writeFileSync(join(root, 'ATHENA.md'), 'b')
    const found = findProjectContextFiles(root).filter((f) => f.file.startsWith(root))
    expect(found.map((f) => f.file)).toEqual([join(root, 'CLAUDE.md'), join(root, 'ATHENA.md')])
  })
})
