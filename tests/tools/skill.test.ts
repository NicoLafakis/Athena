import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveBrainPaths } from '../../src/brain/paths.js'
import { makeSkillTool } from '../../src/tools/skill.js'
import { makeCtx } from '../helpers/tool-ctx.js'

let home: string
let project: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'athena-skill-home-'))
  project = mkdtempSync(join(tmpdir(), 'athena-skill-proj-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
})

function seedSkill(): void {
  const dir = join(home, '.athena', 'skills', 'commit-flow')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    '---\nname: commit-flow\ndescription: Commit cleanly\n---\n# Commit flow\n\nStage by name.\n',
  )
}

describe('makeSkillTool', () => {
  it('is a read-only tool that lists available skills in its description', () => {
    seedSkill()
    const tool = makeSkillTool(resolveBrainPaths({ cwd: project, homeOverride: home }))
    expect(tool.name).toBe('Skill')
    expect(tool.readOnly).toBe(true)
    expect(tool.description).toContain('commit-flow (Commit cleanly)')
  })

  it('returns the skill body with frontmatter stripped for a known skill', async () => {
    seedSkill()
    const tool = makeSkillTool(resolveBrainPaths({ cwd: project, homeOverride: home }))
    const res = await tool.execute({ name: 'commit-flow' }, makeCtx(project))
    expect(res.isError).toBe(false)
    expect(res.output).toBe('# Commit flow\n\nStage by name.')
    expect(res.output).not.toContain('name: commit-flow')
  })

  it('errors with an Available list for an unknown skill', async () => {
    seedSkill()
    const tool = makeSkillTool(resolveBrainPaths({ cwd: project, homeOverride: home }))
    const res = await tool.execute({ name: 'nope' }, makeCtx(project))
    expect(res.isError).toBe(true)
    expect(res.output).toContain('Unknown skill "nope"')
    expect(res.output).toContain('Available: commit-flow')
  })

  it('reports (none defined) in description and errors when no skills exist', async () => {
    const tool = makeSkillTool(resolveBrainPaths({ cwd: project, homeOverride: home }))
    expect(tool.description).toContain('(none defined)')
    const res = await tool.execute({ name: 'anything' }, makeCtx(project))
    expect(res.isError).toBe(true)
    expect(res.output).toContain('Available: (none defined)')
  })
})
