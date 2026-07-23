import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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

// Sample agent + skill seeded on a fresh brain so a first install is non-empty and
// the Skill/Agent machinery has something to show. Seeded only when the user has
// none yet (see ensureBrainScaffold), so an imported brain is never overwritten.
const SAMPLE_AGENT = `---
name: explorer
description: Read-only codebase explorer — searches files and reports findings without making changes
tools: Read, Glob, Grep
model: sonnet
---

You are a read-only codebase explorer. Given a question about the code, you
locate the relevant files and report concise findings with \`path:line\`
citations. You never edit, write, or run mutating commands — your only job is
to find and explain.

Method:
1. Use Glob to find candidate files by name/pattern, Grep to find code by content.
2. Read only the spans you need to answer; do not dump whole files.
3. Report: the answer first, then the evidence as \`path:line\` references.

Be terse. If the answer isn't in the code, say so plainly rather than guessing.
`

const SAMPLE_SKILL = `---
name: commit-flow
description: Review changes and commit them cleanly — run gates, stage specific files, write a clear message
---

# Commit flow

A short procedure for turning a working set of edits into a clean commit.

## Steps
1. \`git status --short\` and \`git diff\` — know exactly what changed. Never stage blindly.
2. Run the project's gates and fix any failure before continuing:
   typecheck, then lint, then tests, then the production build.
3. Stage only the files you intend to commit by name — never \`git add -A\` or \`git add .\`.
4. Write a focused commit message: a \`type(scope): summary\` subject line, then a
   body explaining the *why*, not just the *what*.
5. \`git commit\` the staged files. Push only when asked.

## Why
Gates run last, on the exact tree being committed, so nothing green-locally
slips into a broken commit. Staging by name keeps unrelated churn out of the
history. The message earns its keep when someone reads it in six months.
`

/** True when the directory already holds at least one `*.md` file directly. */
function hasMarkdownFile(dir: string): boolean {
  return existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.md'))
}

/** True when a skill already exists: a direct `*.md`, or a subdir holding SKILL.md. */
function hasSkill(dir: string): boolean {
  if (!existsSync(dir)) return false
  for (const entry of readdirSync(dir)) {
    if (entry.endsWith('.md')) return true
    if (existsSync(join(dir, entry, 'SKILL.md'))) return true
  }
  return false
}

/** First-run scaffold for ~/.athena. Creates missing dirs/files; NEVER overwrites existing ones. */
export function ensureBrainScaffold(paths: BrainPaths): void {
  for (const dir of [
    paths.brainDir,
    paths.memoryDir,
    paths.skillsDir,
    paths.agentsDir,
    paths.commandsDir,
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

  // Seed a sample agent and skill ONLY when the user has none yet, so a fresh
  // install is non-empty while an imported or hand-authored brain is left alone.
  if (!hasMarkdownFile(paths.agentsDir))
    writeFileSync(join(paths.agentsDir, 'explorer.md'), SAMPLE_AGENT, 'utf8')
  if (!hasSkill(paths.skillsDir)) {
    const skillDir = join(paths.skillsDir, 'commit-flow')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), SAMPLE_SKILL, 'utf8')
  }
}
