import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveBrainPaths } from '../../src/brain/paths.js'

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

describe('resolveBrainPaths', () => {
  it('resolves all global paths under <home>/.athena', () => {
    const paths = resolveBrainPaths({ cwd: project, homeOverride: home })
    const brain = join(home, '.athena')
    expect(paths.brainDir).toBe(brain)
    expect(paths.constitutionFile).toBe(join(brain, 'ATHENA.md'))
    expect(paths.settingsFile).toBe(join(brain, 'settings.json'))
    expect(paths.memoryDir).toBe(join(brain, 'memory'))
    expect(paths.memoryIndexFile).toBe(join(brain, 'memory', 'MEMORY.md'))
    expect(paths.skillsDir).toBe(join(brain, 'skills'))
    expect(paths.agentsDir).toBe(join(brain, 'agents'))
    expect(paths.hooksDir).toBe(join(brain, 'hooks'))
    expect(paths.sessionsDir).toBe(join(brain, 'sessions'))
    expect(paths.journalDir).toBe(join(brain, 'journal'))
  })

  it('projectBrainDir is null when <cwd>/.athena does not exist', () => {
    const paths = resolveBrainPaths({ cwd: project, homeOverride: home })
    expect(paths.projectBrainDir).toBeNull()
  })

  it('projectBrainDir is <cwd>/.athena when it exists', () => {
    mkdirSync(join(project, '.athena'), { recursive: true })
    const paths = resolveBrainPaths({ cwd: project, homeOverride: home })
    expect(paths.projectBrainDir).toBe(join(project, '.athena'))
  })
})
