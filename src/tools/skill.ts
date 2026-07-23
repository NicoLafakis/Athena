import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { ToolDefinition } from '../engine/types.js'
import type { BrainPaths } from '../brain/paths.js'
import { parseFrontmatter } from '../brain/loader.js'
import { loadSkillsIndexWithPlugins } from '../brain/plugins.js'

const SkillInput = z.object({
  name: z.string().min(1),
})

export function makeSkillTool(paths: BrainPaths): ToolDefinition<z.infer<typeof SkillInput>> {
  const skills = loadSkillsIndexWithPlugins(paths)
  return {
    name: 'Skill',
    description:
      "Load a skill: injects the named skill's full instructions into the conversation so you can follow its procedure. Available skills: " +
      (skills.length > 0
        ? skills.map((s) => `${s.name} (${s.description})`).join('; ')
        : '(none defined)'),
    schema: SkillInput,
    readOnly: true,
    async execute(input) {
      const index = loadSkillsIndexWithPlugins(paths)
      const entry = index.find((s) => s.name === input.name)
      if (!entry) {
        return {
          output: `Unknown skill "${input.name}". Available: ${
            index.map((s) => s.name).join(', ') || '(none defined)'
          }`,
          isError: true,
        }
      }
      try {
        const src = readFileSync(entry.file, 'utf8')
        const { body } = parseFrontmatter(src)
        const trimmed = body.trim()
        // A skill file with no body past the frontmatter still has something worth
        // returning — fall back to the raw file rather than an empty injection.
        return { output: trimmed || src, isError: false }
      } catch (err) {
        return {
          output: `Failed to load skill "${input.name}": ${(err as Error).message}`,
          isError: true,
        }
      }
    },
  }
}
