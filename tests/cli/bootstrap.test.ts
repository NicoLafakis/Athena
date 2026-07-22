import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveBrainPaths } from '../../src/brain/paths.js'
import { ensureBrainScaffold } from '../../src/harness/bootstrap.js'
import { parseArgs } from '../../src/cli.js'

let home: string
let proj: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'athena-home-'))
  proj = mkdtempSync(join(tmpdir(), 'athena-proj-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(proj, { recursive: true, force: true })
})

describe('ensureBrainScaffold', () => {
  it('first run scaffolds the ~/.athena skeleton with a default ATHENA.md and settings.json', () => {
    const paths = resolveBrainPaths({ cwd: proj, homeOverride: home })
    ensureBrainScaffold(paths)
    for (const dir of [
      paths.memoryDir,
      paths.skillsDir,
      paths.agentsDir,
      paths.hooksDir,
      paths.sessionsDir,
      paths.journalDir,
    ]) {
      expect(existsSync(dir)).toBe(true)
    }
    expect(readFileSync(paths.constitutionFile, 'utf8')).toContain('# Athena')
    expect(JSON.parse(readFileSync(paths.settingsFile, 'utf8'))).toMatchObject({
      permissionMode: 'normal',
    })
    expect(readFileSync(paths.memoryIndexFile, 'utf8')).toContain('# Memory Index')
  })

  it('seeds a sample explorer agent and commit-flow skill on a fresh brain', () => {
    const paths = resolveBrainPaths({ cwd: proj, homeOverride: home })
    ensureBrainScaffold(paths)
    const agentFile = join(paths.agentsDir, 'explorer.md')
    const skillFile = join(paths.skillsDir, 'commit-flow', 'SKILL.md')
    expect(existsSync(agentFile)).toBe(true)
    expect(existsSync(skillFile)).toBe(true)
    expect(readFileSync(agentFile, 'utf8')).toContain('name: explorer')
    expect(readFileSync(skillFile, 'utf8')).toContain('name: commit-flow')
  })

  it('does not seed samples when the brain already has an agent and a skill', () => {
    const paths = resolveBrainPaths({ cwd: proj, homeOverride: home })
    mkdirSync(paths.agentsDir, { recursive: true })
    mkdirSync(join(paths.skillsDir, 'mine'), { recursive: true })
    writeFileSync(join(paths.agentsDir, 'mine.md'), '---\nname: mine\ndescription: d\n---\nPrompt.\n')
    writeFileSync(
      join(paths.skillsDir, 'mine', 'SKILL.md'),
      '---\nname: mine\ndescription: d\n---\nBody.\n',
    )
    ensureBrainScaffold(paths)
    expect(existsSync(join(paths.agentsDir, 'explorer.md'))).toBe(false)
    expect(existsSync(join(paths.skillsDir, 'commit-flow'))).toBe(false)
  })

  it('scaffold never overwrites an existing constitution or settings', () => {
    const paths = resolveBrainPaths({ cwd: proj, homeOverride: home })
    mkdirSync(paths.memoryDir, { recursive: true })
    writeFileSync(paths.constitutionFile, '# My custom constitution\n', 'utf8')
    writeFileSync(paths.settingsFile, '{"permissionMode":"trusted"}\n', 'utf8')
    writeFileSync(paths.memoryIndexFile, '# Mine\n', 'utf8')
    ensureBrainScaffold(paths)
    expect(readFileSync(paths.constitutionFile, 'utf8')).toBe('# My custom constitution\n')
    expect(readFileSync(paths.settingsFile, 'utf8')).toBe('{"permissionMode":"trusted"}\n')
    expect(readFileSync(paths.memoryIndexFile, 'utf8')).toBe('# Mine\n')
  })
})

describe('parseArgs', () => {
  it('handles default run, --resume, --continue, and import <path>', () => {
    expect(parseArgs([])).toEqual({ command: 'run' })
    expect(parseArgs(['--resume'])).toEqual({ command: 'resume' })
    expect(parseArgs(['--continue'])).toEqual({ command: 'continue' })
    expect(parseArgs(['import', 'C:/old/ares', '--force'])).toEqual({
      command: 'import',
      sourceDir: 'C:/old/ares',
      force: true,
    })
    expect(parseArgs(['import'])).toEqual({
      command: 'error',
      message: 'Usage: athena import <path> [--force]',
    })
  })

  it('handles --help', () => {
    expect(parseArgs(['--help'])).toEqual({ command: 'help' })
    expect(parseArgs(['-h'])).toEqual({ command: 'help' })
  })

  it('errors on unknown arguments instead of silently starting a fresh session', () => {
    expect(parseArgs(['--continu'])).toEqual({
      command: 'error',
      message: 'Unknown argument: --continu (try --help)',
    })
    expect(parseArgs(['--resume', 'extra'])).toEqual({
      command: 'error',
      message: 'Unknown argument: extra (try --help)',
    })
  })
})
