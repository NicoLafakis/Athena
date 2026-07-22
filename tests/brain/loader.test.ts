import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveBrainPaths } from '../../src/brain/paths.js'
import {
  parseFrontmatter,
  loadConstitution,
  loadMemoryIndex,
  loadSkillsIndex,
  loadAgentsIndex,
} from '../../src/brain/loader.js'

let home: string
let project: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'athena-home-'))
  project = mkdtempSync(join(tmpdir(), 'athena-proj-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
})

describe('parseFrontmatter', () => {
  it('parses key/value attrs and returns the body', () => {
    const { attrs, body } = parseFrontmatter('---\nname: x\ndescription: Some desc\n---\n# Body\n')
    expect(attrs).toEqual({ name: 'x', description: 'Some desc' })
    expect(body).toBe('# Body\n')
  })

  it('returns empty attrs and full source when no frontmatter', () => {
    const src = '# Just markdown\n'
    const { attrs, body } = parseFrontmatter(src)
    expect(attrs).toEqual({})
    expect(body).toBe(src)
  })

  it('handles CRLF line endings', () => {
    const { attrs, body } = parseFrontmatter('---\r\nname: crlf\r\n---\r\nbody')
    expect(attrs).toEqual({ name: 'crlf' })
    expect(body).toBe('body')
  })
})

describe('loadConstitution / loadMemoryIndex', () => {
  it('return null when files are absent', () => {
    const paths = resolveBrainPaths({ cwd: project, homeOverride: home })
    expect(loadConstitution(paths)).toBeNull()
    expect(loadMemoryIndex(paths)).toBeNull()
  })

  it('return file contents when present', () => {
    mkdirSync(join(home, '.athena', 'memory'), { recursive: true })
    writeFileSync(join(home, '.athena', 'ATHENA.md'), '# Constitution\n')
    writeFileSync(join(home, '.athena', 'memory', 'MEMORY.md'), '# Memory Index\n')
    const paths = resolveBrainPaths({ cwd: project, homeOverride: home })
    expect(loadConstitution(paths)).toBe('# Constitution\n')
    expect(loadMemoryIndex(paths)).toBe('# Memory Index\n')
  })
})

describe('loadSkillsIndex', () => {
  it('loads skills index from SKILL.md frontmatter (both skills/<name>/SKILL.md and skills/<name>.md)', () => {
    const skills = join(home, '.athena', 'skills')
    mkdirSync(join(skills, 'coding-sop'), { recursive: true })
    writeFileSync(join(skills, 'coding-sop', 'SKILL.md'),
      '---\nname: coding-sop\ndescription: Pre-commit SOP\n---\n# Body\n')
    writeFileSync(join(skills, 'quick.md'), '---\nname: quick\ndescription: One-file skill\n---\nbody')
    const idx = loadSkillsIndex(resolveBrainPaths({ cwd: project, homeOverride: home }))
    expect(idx.map((s) => s.name).sort()).toEqual(['coding-sop', 'quick'])
    expect(idx.find((s) => s.name === 'coding-sop')!.description).toBe('Pre-commit SOP')
  })

  it('project .athena/skills overrides a global skill of the same name', () => {
    const globalSkills = join(home, '.athena', 'skills')
    mkdirSync(globalSkills, { recursive: true })
    writeFileSync(join(globalSkills, 'dup.md'), '---\nname: dup\ndescription: global\n---\nbody')
    const projectSkills = join(project, '.athena', 'skills')
    mkdirSync(projectSkills, { recursive: true })
    writeFileSync(join(projectSkills, 'dup.md'), '---\nname: dup\ndescription: project\n---\nbody')
    const idx = loadSkillsIndex(resolveBrainPaths({ cwd: project, homeOverride: home }))
    expect(idx).toHaveLength(1)
    expect(idx[0]!.description).toBe('project')
  })

  it('skips files without a name attr', () => {
    const skills = join(home, '.athena', 'skills')
    mkdirSync(skills, { recursive: true })
    writeFileSync(join(skills, 'noname.md'), 'just markdown, no frontmatter')
    const idx = loadSkillsIndex(resolveBrainPaths({ cwd: project, homeOverride: home }))
    expect(idx).toEqual([])
  })
})

describe('loadAgentsIndex', () => {
  it('loads agents index with tools list and model from frontmatter', () => {
    const agents = join(home, '.athena', 'agents')
    mkdirSync(agents, { recursive: true })
    writeFileSync(join(agents, 'researcher.md'),
      '---\nname: researcher\ndescription: Read-only researcher\ntools: Read, Glob, Grep\nmodel: claude-haiku-4-5\n---\nYou research.\n')
    const idx = loadAgentsIndex(resolveBrainPaths({ cwd: project, homeOverride: home }))
    expect(idx[0]).toMatchObject({
      name: 'researcher',
      tools: ['Read', 'Glob', 'Grep'],
      model: 'claude-haiku-4-5',
    })
    expect(idx[0]!.systemPrompt).toContain('You research.')
  })

  it('tools and model default to null when absent from frontmatter', () => {
    const agents = join(home, '.athena', 'agents')
    mkdirSync(agents, { recursive: true })
    writeFileSync(join(agents, 'plain.md'), '---\nname: plain\ndescription: d\n---\nPrompt.\n')
    const idx = loadAgentsIndex(resolveBrainPaths({ cwd: project, homeOverride: home }))
    expect(idx[0]!.tools).toBeNull()
    expect(idx[0]!.model).toBeNull()
  })

  it('project .athena/agents overrides a global agent of the same name', () => {
    const globalAgents = join(home, '.athena', 'agents')
    mkdirSync(globalAgents, { recursive: true })
    writeFileSync(join(globalAgents, 'dup.md'), '---\nname: dup\ndescription: global agent\n---\nGlobal prompt.\n')
    const projectAgents = join(project, '.athena', 'agents')
    mkdirSync(projectAgents, { recursive: true })
    writeFileSync(join(projectAgents, 'dup.md'), '---\nname: dup\ndescription: project agent\n---\nProject prompt.\n')
    const idx = loadAgentsIndex(resolveBrainPaths({ cwd: project, homeOverride: home }))
    expect(idx).toHaveLength(1)
    expect(idx[0]!.description).toBe('project agent')
    expect(idx[0]!.systemPrompt).toBe('Project prompt.')
  })
})
