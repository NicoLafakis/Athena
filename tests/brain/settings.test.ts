import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveBrainPaths } from '../../src/brain/paths.js'
import { loadSettings, SettingsSchema } from '../../src/brain/settings.js'

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

describe('loadSettings', () => {
  it('returns schema defaults when no settings.json exists', () => {
    const paths = resolveBrainPaths({ cwd: project, homeOverride: home })
    const s = loadSettings(paths)
    expect(s.model).toBe(SettingsSchema.parse({}).model)
    expect(s.permissionMode).toBe('normal')
    expect(s.allow).toEqual([])
  })

  it('project settings override global scalars and concatenate rule arrays', () => {
    mkdirSync(join(home, '.athena'), { recursive: true })
    writeFileSync(join(home, '.athena', 'settings.json'),
      JSON.stringify({ model: 'global-model', allow: ['Read(**)'] }))
    mkdirSync(join(project, '.athena'), { recursive: true })
    writeFileSync(join(project, '.athena', 'settings.json'),
      JSON.stringify({ model: 'project-model', allow: ['Bash(git:*)'] }))
    const s = loadSettings(resolveBrainPaths({ cwd: project, homeOverride: home }))
    expect(s.model).toBe('project-model')
    expect(s.allow).toEqual(['Read(**)', 'Bash(git:*)'])
  })

  it('throws a readable error on invalid settings', () => {
    mkdirSync(join(home, '.athena'), { recursive: true })
    writeFileSync(join(home, '.athena', 'settings.json'), JSON.stringify({ permissionMode: 'yolo' }))
    expect(() => loadSettings(resolveBrainPaths({ cwd: project, homeOverride: home })))
      .toThrow(/permissionMode/)
  })

  it('throws a readable error on malformed JSON', () => {
    mkdirSync(join(home, '.athena'), { recursive: true })
    writeFileSync(join(home, '.athena', 'settings.json'), '{ not json')
    expect(() => loadSettings(resolveBrainPaths({ cwd: project, homeOverride: home })))
      .toThrow(/Malformed JSON/)
  })
})
