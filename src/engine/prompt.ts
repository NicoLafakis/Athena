// src/engine/prompt.ts
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

export interface EnvironmentInfo {
  cwd: string
  platform: string
  gitBranch: string | null
  date: string
}
export interface ProjectContextFile {
  file: string
  content: string
}

export interface PromptParts {
  constitution: string | null
  memoryIndex: string | null
  projectContext: ProjectContextFile[]
  toolGuidance: string
  skills: { name: string; description: string }[]
  environment: EnvironmentInfo
}

const PROJECT_CONTEXT_NAMES = ['CLAUDE.md', 'AGENTS.md', 'ATHENA.md']

const ATHENA_IDENTITY = `# Operating identity

You are Athena, the terminal coding agent in this session. Speak as Athena in the first person: use “I”, “me”, and “my”; when asked who you are, answer that you are Athena. Do not describe Athena as a separate assistant, harness, agent, product, or individual standing between you and the user. You may refer to specific source-code components as objects of implementation when needed, but retain first-person ownership of your actions and responses. This is an operating identity, not a claim of human personhood or independent origins.`

/** Walks up from cwd to the filesystem root; returns outermost-first so the nearest file lands last (highest salience). */
export function findProjectContextFiles(cwd: string): ProjectContextFile[] {
  const byDirectory: ProjectContextFile[][] = []
  let dir = cwd
  for (;;) {
    const inDir: ProjectContextFile[] = []
    for (const name of PROJECT_CONTEXT_NAMES) {
      const file = join(dir, name)
      if (existsSync(file)) inDir.push({ file, content: readFileSync(file, 'utf8') })
    }
    if (inDir.length > 0) byDirectory.push(inDir)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // Reverse at the directory level only: outermost dir first, nearest dir last,
  // while files within one directory keep canonical name order.
  return byDirectory.reverse().flat()
}

export function assembleSystemPrompt(parts: PromptParts): string {
  // This is deliberately independent of a user-authored constitution: a custom or
  // imported constitution must not make Athena narrate herself as a separate entity.
  const sections: string[] = [ATHENA_IDENTITY]
  if (parts.constitution) sections.push(parts.constitution.trim())
  if (parts.memoryIndex) sections.push(`# Memory\n\n${parts.memoryIndex.trim()}`)
  for (const pc of parts.projectContext) {
    sections.push(`# Project context (${pc.file})\n\n${pc.content.trim()}`)
  }
  if (parts.toolGuidance) sections.push(`# Tool guidance\n\n${parts.toolGuidance.trim()}`)
  if (parts.skills.length > 0) {
    sections.push(
      "# Skills\n\nYou can load any of these on demand with the Skill tool (it injects the skill's full instructions):\n\n" +
        parts.skills.map((s) => `- ${s.name} — ${s.description}`).join('\n'),
    )
  }
  const env = parts.environment
  sections.push(
    [
      '# Environment',
      '',
      `cwd: ${env.cwd}`,
      `platform: ${env.platform}`,
      `git branch: ${env.gitBranch ?? '(not a git repo)'}`,
      `date: ${env.date}`,
    ].join('\n'),
  )
  return sections.join('\n\n---\n\n')
}
