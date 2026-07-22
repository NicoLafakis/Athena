import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { join, resolve, relative, dirname, sep } from 'node:path'
import { z } from 'zod'
import type { ToolDefinition } from '../engine/types.js'

const MemoryInput = z.object({
  op: z.enum(['list', 'read', 'write', 'delete']),
  path: z.string().optional(), // relative to memory dir; required for read/write/delete
  content: z.string().optional(), // required for write
  description: z.string().optional(), // index line annotation for write
})

function memoryDirOf(brainDir: string): string {
  return join(brainDir, 'memory')
}
function indexFileOf(brainDir: string): string {
  return join(memoryDirOf(brainDir), 'MEMORY.md')
}

function safeResolve(memDir: string, rel: string): string | null {
  const abs = resolve(memDir, rel)
  return abs === memDir || abs.startsWith(memDir + sep) ? abs : null
}

function updateIndex(
  brainDir: string,
  rel: string,
  action: 'add' | 'remove',
  description: string,
): void {
  const idx = indexFileOf(brainDir)
  const lines = existsSync(idx) ? readFileSync(idx, 'utf8').split('\n') : ['# Memory Index', '']
  const relPosix = rel.replaceAll('\\', '/')
  const marker = `](${relPosix})`
  const filtered = lines.filter((l) => !l.includes(marker))
  if (action === 'add') filtered.push(`- [${relPosix}](${relPosix}) — ${description}`)
  mkdirSync(dirname(idx), { recursive: true })
  writeFileSync(idx, filtered.join('\n').trimEnd() + '\n', 'utf8')
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const e of readdirSync(dir)) {
    const full = join(dir, e)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

export const memoryTool: ToolDefinition<z.infer<typeof MemoryInput>> = {
  name: 'Memory',
  description:
    'List, read, write, or delete Brain memory files (one fact per file). Writes and deletes keep MEMORY.md in sync.',
  schema: MemoryInput,
  readOnly: false,
  async execute(input, ctx) {
    const memDir = memoryDirOf(ctx.brainDir)
    if (input.op === 'list') {
      const files = walk(memDir).map((f) => relative(memDir, f).replaceAll('\\', '/'))
      return { output: files.length ? files.join('\n') : '(memory is empty)', isError: false }
    }
    if (!input.path) return { output: `op ${input.op} requires path`, isError: true }
    const abs = safeResolve(memDir, input.path)
    if (!abs) return { output: `Path escapes memory dir: ${input.path}`, isError: true }
    const rel = relative(memDir, abs)
    switch (input.op) {
      case 'read': {
        if (!existsSync(abs)) return { output: `No memory at ${rel}`, isError: true }
        return { output: readFileSync(abs, 'utf8'), isError: false }
      }
      case 'write': {
        if (input.content === undefined) return { output: 'write requires content', isError: true }
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, input.content, 'utf8')
        updateIndex(ctx.brainDir, rel, 'add', input.description ?? input.content.split('\n')[0] ?? '')
        return { output: `Memory written: ${rel} (index updated)`, isError: false }
      }
      case 'delete': {
        if (!existsSync(abs)) return { output: `No memory at ${rel}`, isError: true }
        rmSync(abs)
        updateIndex(ctx.brainDir, rel, 'remove', '')
        return { output: `Memory deleted: ${rel} (index updated)`, isError: false }
      }
    }
  },
}
