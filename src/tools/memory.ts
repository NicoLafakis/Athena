import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  rmSync,
} from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { z } from 'zod'
import type { ToolDefinition } from '../engine/types.js'
import { resolveMemoryAccess } from '../harness/memory-access.js'
import { ResourcePolicy } from '../harness/resource-policy.js'

const MemoryInput = z.object({
  op: z.enum(['list', 'read', 'write', 'delete']),
  path: z.string().optional(), // relative to memory dir; required for read/write/delete
  content: z.string().optional(), // required for write
  description: z.string().optional(), // index line annotation for write
})

function memoryDirOf(brainDir: string): string {
  return join(brainDir, 'memory')
}
function updateIndex(
  idx: string,
  rel: string,
  action: 'add' | 'remove',
  description: string,
): void {
  const lines = existsSync(idx) ? readFileSync(idx, 'utf8').split('\n') : ['# Memory Index', '']
  const relPosix = rel.replaceAll('\\', '/')
  const marker = `](${relPosix})`
  const filtered = lines.filter((l) => !l.includes(marker))
  if (action === 'add') filtered.push(`- [${relPosix}](${relPosix}) — ${description}`)
  mkdirSync(dirname(idx), { recursive: true })
  writeFileSync(idx, filtered.join('\n').trimEnd() + '\n', 'utf8')
}

export const memoryTool: ToolDefinition<z.infer<typeof MemoryInput>> = {
  name: 'Memory',
  description:
    'List, read, write, or delete Brain memory files (one fact per file). Writes and deletes keep MEMORY.md in sync.',
  schema: MemoryInput,
  readOnly: false,
  async execute(input, ctx) {
    const memDir = memoryDirOf(ctx.brainDir)
    let access: ReturnType<typeof resolveMemoryAccess>
    try {
      access = resolveMemoryAccess(memDir, input)
      // Memory has its own narrow root, not the ordinary workspace resolver.
      // Keep read-only mode and the unconditional OS fence for direct execution too.
      const policy = new ResourcePolicy(access.root, ctx.sandboxMode === 'read-only' ? 'read-only' : 'workspace-write')
      for (const target of access.targets) policy.resolvePath(target, access.readOnly ? 'read' : 'write')
    } catch (error) {
      return { output: (error as Error).message, isError: true }
    }
    if (input.op === 'list') {
      const files = access.files.map((f) => relative(access.root, f).replaceAll('\\', '/'))
      return { output: files.length ? files.join('\n') : '(memory is empty)', isError: false }
    }
    const abs = access.target
    const rel = relative(access.root, abs)
    switch (input.op) {
      case 'read': {
        if (!existsSync(abs)) return { output: `No memory at ${rel}`, isError: true }
        return { output: readFileSync(abs, 'utf8'), isError: false }
      }
      case 'write': {
        if (input.content === undefined) return { output: 'write requires content', isError: true }
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, input.content, 'utf8')
        updateIndex(access.index!, rel, 'add', input.description ?? input.content.split('\n')[0] ?? '')
        return { output: `Memory written: ${rel} (index updated)`, isError: false }
      }
      case 'delete': {
        if (!existsSync(abs)) return { output: `No memory at ${rel}`, isError: true }
        rmSync(abs)
        updateIndex(access.index!, rel, 'remove', '')
        return { output: `Memory deleted: ${rel} (index updated)`, isError: false }
      }
    }
  },
}
