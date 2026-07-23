import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

export interface BrainPaths {
  brainDir: string
  constitutionFile: string
  settingsFile: string
  credentialsFile: string
  memoryDir: string
  memoryIndexFile: string
  skillsDir: string
  agentsDir: string
  commandsDir: string
  hooksDir: string
  sessionsDir: string
  journalDir: string
  projectBrainDir: string | null // <cwd>/.athena when present
}

export function resolveBrainPaths(opts: { cwd: string; homeOverride?: string }): BrainPaths {
  const brainDir = join(opts.homeOverride ?? homedir(), '.athena')
  const projectBrain = join(opts.cwd, '.athena')
  return {
    brainDir,
    constitutionFile: join(brainDir, 'ATHENA.md'),
    settingsFile: join(brainDir, 'settings.json'),
    credentialsFile: join(brainDir, 'credentials.json'),
    memoryDir: join(brainDir, 'memory'),
    memoryIndexFile: join(brainDir, 'memory', 'MEMORY.md'),
    skillsDir: join(brainDir, 'skills'),
    agentsDir: join(brainDir, 'agents'),
    commandsDir: join(brainDir, 'commands'),
    hooksDir: join(brainDir, 'hooks'),
    sessionsDir: join(brainDir, 'sessions'),
    journalDir: join(brainDir, 'journal'),
    projectBrainDir: existsSync(projectBrain) ? projectBrain : null,
  }
}
