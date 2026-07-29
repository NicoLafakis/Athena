import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

export interface BrainPaths {
  brainDir: string
  constitutionFile: string
  settingsFile: string
  credentialsFile: string
  credentialVaultFile: string
  trustFile: string
  memoryDir: string
  memoryIndexFile: string
  skillsDir: string
  agentsDir: string
  agentRunsDir: string
  commandsDir: string
  pluginsDir: string
  pluginStateFile: string
  hooksDir: string
  sessionsDir: string
  journalDir: string
  watchesFile: string
  runsDir: string
  learningDir: string
  learningCandidatesDir: string
  learningEvaluationsDir: string
  learningLineageFile: string
  learningSigningKeyFile: string
  learnedMemoryFile: string
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
    credentialVaultFile: join(brainDir, 'credentials.vault.json'),
    trustFile: join(brainDir, 'trust.json'),
    memoryDir: join(brainDir, 'memory'),
    memoryIndexFile: join(brainDir, 'memory', 'MEMORY.md'),
    skillsDir: join(brainDir, 'skills'),
    agentsDir: join(brainDir, 'agents'),
    agentRunsDir: join(brainDir, 'agent-runs'),
    commandsDir: join(brainDir, 'commands'),
    pluginsDir: join(brainDir, 'plugins'),
    pluginStateFile: join(brainDir, 'plugins.json'),
    hooksDir: join(brainDir, 'hooks'),
    sessionsDir: join(brainDir, 'sessions'),
    journalDir: join(brainDir, 'journal'),
    watchesFile: join(brainDir, 'watches.json'),
    runsDir: join(brainDir, 'runs'),
    learningDir: join(brainDir, 'learning'),
    learningCandidatesDir: join(brainDir, 'learning', 'candidates'),
    learningEvaluationsDir: join(brainDir, 'learning', 'evaluations'),
    learningLineageFile: join(brainDir, 'learning', 'lineage.jsonl'),
    learningSigningKeyFile: join(brainDir, 'learning', 'signing-key.pem'),
    learnedMemoryFile: join(brainDir, 'memory', 'learned.jsonl'),
    projectBrainDir: existsSync(projectBrain) ? projectBrain : null,
  }
}
