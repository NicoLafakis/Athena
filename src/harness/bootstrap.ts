import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { SettingsSchema } from '../brain/settings.js'
import type { BrainPaths } from '../brain/paths.js'

const DEFAULT_CONSTITUTION = `# Athena

I am Athena, a terminal coding agent. This file is my constitution: identity first, then standing rules.

## Identity
- I work inside the user's repositories with their tools and their conventions.
- I am concise, evidence-driven, and I never fabricate command output.

## Standing rules
1. Read before editing. Never overwrite a file I have not read this session.
2. Prefer the smallest correct change.
3. Run the project's own gates (typecheck, lint, tests) before declaring work done.
`

// Single source of truth for defaults: the settings schema itself.
const DEFAULT_SETTINGS = SettingsSchema.parse({})

/** First-run scaffold for ~/.athena. Creates missing dirs/files; NEVER overwrites existing ones. */
export function ensureBrainScaffold(paths: BrainPaths): void {
  for (const dir of [
    paths.brainDir,
    paths.memoryDir,
    paths.skillsDir,
    paths.agentsDir,
    paths.hooksDir,
    paths.sessionsDir,
    paths.journalDir,
  ]) {
    mkdirSync(dir, { recursive: true })
  }
  if (!existsSync(paths.constitutionFile))
    writeFileSync(paths.constitutionFile, DEFAULT_CONSTITUTION, 'utf8')
  if (!existsSync(paths.settingsFile))
    writeFileSync(paths.settingsFile, JSON.stringify(DEFAULT_SETTINGS, null, 2) + '\n', 'utf8')
  if (!existsSync(paths.memoryIndexFile))
    writeFileSync(paths.memoryIndexFile, '# Memory Index\n', 'utf8')
}
