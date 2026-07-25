import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { ToolDefinition } from '../engine/types.js'
import type { BrainPaths } from '../brain/paths.js'
import { parseFrontmatter } from '../brain/loader.js'
import { loadSkillsIndexWithPlugins } from '../brain/plugins.js'

const SkillInput = z.object({
  name: z.string().min(1),
  resource: z.string().optional(),
})

const RESOURCE_LIST_CAP = 200
const RESOURCE_READ_CAP = 200_000

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..')
}

function listResources(root: string, instructionFile: string): string[] {
  const files: string[] = []
  const visit = (dir: string) => {
    if (files.length >= RESOURCE_LIST_CAP) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (files.length >= RESOURCE_LIST_CAP) return
      const full = resolve(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) visit(full)
      else if (full !== instructionFile) files.push(relative(root, full).replaceAll('\\', '/'))
    }
  }
  visit(root)
  return files
}

export function makeSkillTool(paths: BrainPaths): ToolDefinition<z.infer<typeof SkillInput>> {
  const skills = loadSkillsIndexWithPlugins(paths)
  return {
    name: 'Skill',
    description:
      "Load a skill's instructions or one of its supporting resources. Skill results include the canonical root so relative scripts, references, and assets resolve correctly. Available skills: " +
      (skills.length > 0
        ? skills.map((skill) => `${skill.name} (${skill.description}) [root ${skill.root}]`).join('; ')
        : '(none defined)'),
    schema: SkillInput,
    readOnly: true,
    async execute(input) {
      const index = loadSkillsIndexWithPlugins(paths)
      const entry = index.find((skill) => skill.name === input.name)
      if (!entry) {
        return {
          output: `Unknown skill "${input.name}". Available: ${
            index.map((skill) => skill.name).join(', ') || '(none defined)'
          }`,
          isError: true,
        }
      }
      try {
        const root = realpathSync.native(entry.root)
        if (input.resource) {
          const candidate = resolve(root, input.resource)
          const real = realpathSync.native(candidate)
          if (!isWithin(root, real) || lstatSync(candidate).isSymbolicLink()) {
            return { output: `Skill resource escapes its root: ${input.resource}`, isError: true }
          }
          const body = readFileSync(real, 'utf8')
          const cap = Math.min(entry.maxContextChars, RESOURCE_READ_CAP)
          return {
            output:
              `Skill root: ${root}\nResource: ${relative(root, real).replaceAll('\\', '/')}\n\n` +
              (body.length > cap ? `${body.slice(0, cap)}\n[resource truncated at ${cap} chars]` : body),
            isError: false,
          }
        }
        const src = readFileSync(entry.file, 'utf8')
        const { body } = parseFrontmatter(src)
        const resources = listResources(root, entry.file)
        const instructions = (body.trim() || src).slice(0, entry.maxContextChars)
        return {
          output: [
            `Skill root: ${root}`,
            `Instruction file: ${entry.file}`,
            resources.length
              ? `Supporting resources (${resources.length}${resources.length === RESOURCE_LIST_CAP ? '+' : ''}): ${resources.join(', ')}`
              : 'Supporting resources: (none)',
            '',
            instructions,
          ].join('\n'),
          isError: false,
        }
      } catch (err) {
        return {
          output: `Failed to load skill "${input.name}": ${(err as Error).message}`,
          isError: true,
        }
      }
    },
  }
}
