import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { ToolContext, ToolDefinition } from '../engine/types.js'
import {
  assertReadPrecondition,
  atomicWriteFile,
  recordKnownFile,
  revalidateToolPath,
  resolveToolPath,
} from './files.js'

const ApplyPatchInput = z.object({
  patch: z.string().min(1).max(1_000_000),
})

interface ParsedChange {
  kind: 'add' | 'update' | 'delete'
  path: string
  moveTo?: string
  lines: string[]
}

interface PlannedChange {
  path: string
  next: string | null
  existed: boolean
}

const MAX_TARGET_BYTES = 10 * 1024 * 1024

function parsePatch(source: string): ParsedChange[] {
  const lines = source.replaceAll('\r\n', '\n').split('\n')
  if (lines.shift() !== '*** Begin Patch') throw new Error('Patch must start with *** Begin Patch')
  const changes: ParsedChange[] = []
  let current: ParsedChange | null = null
  for (const line of lines) {
    if (line === '*** End Patch') {
      if (current) changes.push(current)
      current = null
      break
    }
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line)
    if (header) {
      if (current) changes.push(current)
      current = {
        kind: header[1]!.toLowerCase() as ParsedChange['kind'],
        path: header[2]!,
        lines: [],
      }
      continue
    }
    const move = /^\*\*\* Move to: (.+)$/.exec(line)
    if (move && current?.kind === 'update') {
      current.moveTo = move[1]!
      continue
    }
    if (!current) {
      if (line.trim() !== '') throw new Error(`Unexpected patch line: ${line}`)
      continue
    }
    current.lines.push(line)
  }
  if (current) throw new Error('Patch must end with *** End Patch')
  if (changes.length === 0) throw new Error('Patch contains no file changes')
  if (changes.length > 100) throw new Error('Patch exceeds the 100-file limit')
  return changes
}

function applyUpdate(original: string, patchLines: string[], path: string): string {
  const trailingNewline = original.endsWith('\n')
  const sourceLines = original.replaceAll('\r\n', '\n').split('\n')
  if (trailingNewline) sourceLines.pop()
  const output = [...sourceLines]
  const hunks: string[][] = []
  let current: string[] | null = null
  for (const line of patchLines) {
    if (line === '@@' || line.startsWith('@@ ')) {
      if (current) hunks.push(current)
      current = []
      continue
    }
    if (!current) current = []
    current.push(line)
  }
  if (current) hunks.push(current)
  let cursor = 0
  for (const hunk of hunks) {
    const oldLines: string[] = []
    const newLines: string[] = []
    for (const line of hunk) {
      const prefix = line[0]
      const text = line.slice(1)
      if (prefix === ' ' || prefix === '-') oldLines.push(text)
      if (prefix === ' ' || prefix === '+') newLines.push(text)
      if (![' ', '-', '+'].includes(prefix ?? '')) {
        throw new Error(`Invalid update line for ${path}: ${line}`)
      }
    }
    let index = cursor
    if (oldLines.length > 0) {
      const matches: number[] = []
      for (let candidate = cursor; candidate <= output.length - oldLines.length; candidate++) {
        if (oldLines.every((line, offset) => output[candidate + offset] === line)) {
          matches.push(candidate)
        }
      }
      if (matches.length === 0) throw new Error(`Patch context did not match ${path}`)
      if (matches.length > 1) throw new Error(`Patch context is ambiguous in ${path}`)
      index = matches[0]!
    }
    output.splice(index, oldLines.length, ...newLines)
    cursor = index + newLines.length
  }
  return output.join('\n') + (trailingNewline ? '\n' : '')
}

async function planChange(change: ParsedChange, ctx: ToolContext): Promise<PlannedChange[]> {
  const path = resolveToolPath(ctx, change.path, change.kind === 'delete' ? 'write' : 'write')
  const existed = existsSync(path)
  if (change.kind === 'add') {
    if (existed) throw new Error(`Cannot add existing file: ${change.path}`)
    if (change.lines.some((line) => !line.startsWith('+'))) {
      throw new Error(`Every added-file line must start with +: ${change.path}`)
    }
    return [{ path, existed: false, next: change.lines.map((line) => line.slice(1)).join('\n') + '\n' }]
  }
  if (!existed) throw new Error(`File does not exist: ${change.path}`)
  await assertReadPrecondition(path, ctx)
  if ((await stat(path)).size > MAX_TARGET_BYTES) {
    throw new Error(`Patch target exceeds ${MAX_TARGET_BYTES} bytes: ${change.path}`)
  }
  const original = await readFile(path, 'utf8')
  if (change.kind === 'delete') return [{ path, existed: true, next: null }]
  const updated = applyUpdate(original, change.lines, change.path)
  if (!change.moveTo) return [{ path, existed: true, next: updated }]
  const destination = resolveToolPath(ctx, change.moveTo, 'write')
  if (existsSync(destination)) throw new Error(`Move destination exists: ${change.moveTo}`)
  return [
    { path, existed: true, next: null },
    { path: destination, existed: false, next: updated },
  ]
}

async function commitPlan(plan: PlannedChange[], ctx: ToolContext): Promise<string[]> {
  const applied: Array<PlannedChange & { backup?: string }> = []
  const backups: string[] = []
  try {
    for (const change of plan) {
      revalidateToolPath(ctx, change.path, 'write')
      let backup: string | undefined
      if (change.existed) {
        backup = `${change.path}.athena-backup-${randomUUID()}`
        await rename(change.path, backup)
        backups.push(backup)
      }
      applied.push({ ...change, backup })
      if (change.next !== null) {
        await mkdir(dirname(change.path), { recursive: true })
        revalidateToolPath(ctx, change.path, 'write')
        await atomicWriteFile(change.path, change.next)
      }
    }
  } catch (error) {
    for (const change of [...applied].reverse()) {
      await rm(change.path, { force: true }).catch(() => {})
      if (change.backup) await rename(change.backup, change.path).catch(() => {})
    }
    throw error
  }
  for (const backup of backups) await rm(backup, { force: true })
  return plan.map((change) => change.path)
}

export const applyPatchTool: ToolDefinition<z.infer<typeof ApplyPatchInput>> = {
  name: 'ApplyPatch',
  description:
    'Apply a transactional multi-file *** Begin Patch / *** Add|Update|Delete File patch. ' +
    'Existing files must have been Read first; update context must be unique.',
  schema: ApplyPatchInput,
  readOnly: false,
  async execute(input, ctx) {
    try {
      const changes = parsePatch(input.patch)
      const plan: PlannedChange[] = []
      for (const change of changes) plan.push(...(await planChange(change, ctx)))
      const duplicate = plan.find(
        (change, index) => plan.findIndex((item) => item.path === change.path) !== index,
      )
      if (duplicate) throw new Error(`Patch changes the same target more than once: ${duplicate.path}`)
      const paths = await commitPlan(plan, ctx)
      for (const change of plan) {
        if (change.next !== null) await recordKnownFile(change.path, ctx)
        else {
          ctx.fileReadRegistry.delete(change.path)
          ctx.fileReadHashes?.delete(change.path)
        }
      }
      return {
        output: `Applied ${changes.length} patch change(s):\n${paths.join('\n')}`,
        isError: false,
      }
    } catch (error) {
      return { output: `ApplyPatch failed: ${(error as Error).message}`, isError: true }
    }
  },
}
