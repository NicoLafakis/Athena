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
import { MemoryHygieneStore } from '../brain/hygiene.js'
import { SpeechActSchema } from '../continuity/schemas.js'
import { ContinuityStore } from '../continuity/store.js'
import { reviewSemanticCandidate } from '../continuity/candidates.js'
import { semanticSourcesAvailable } from '../continuity/semantic-source.js'

const MemoryInput = z.object({
  op: z.enum(['list', 'read', 'write', 'delete', 'remember', 'review', 'supersede', 'forget']),
  path: z.string().optional(), // relative to memory dir; required for read/write/delete
  content: z.string().optional(), // required for write
  description: z.string().optional(), // index line annotation for write
  speechAct: SpeechActSchema.optional(),
  scope: z.enum(['global', 'project']).optional(),
  sensitivity: z.enum(['ordinary', 'sensitive']).optional(),
  validFrom: z.string().optional(),
  validUntil: z.string().optional(),
  memoryId: z.string().uuid().optional(),
  decision: z.enum(['promote', 'reject']).optional(),
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
    'List, read, write, or delete Brain memory files. For current personal facts, use only semantic records marked active and within their valid dates; treat candidates as unconfirmed and superseded records as historical. The model-facing read action never returns candidate, flagged, rejected, tombstoned, or forgotten semantic content. Managed semantic reads verify that each cited session line is still available, unchanged, and user-authored, and reject sources suppressed by continuity tombstones; do not use a memory whose source is unavailable or changed. Use remember only when the user explicitly asks to retain a fact; questions and hypotheticals are not facts. Use review only after the user accepts or rejects a candidate; promotion revalidates every inferred source against the complete local continuity index and its current session lines. Supersede only when the user explicitly corrects an active memory. Forget only when the user explicitly asks to forget a derived semantic memory, using its memoryId; this erases the derived text and keeps its original session available for historical recall. Source links come from persisted user messages. Writes and deletes keep MEMORY.md in sync.',
  schema: MemoryInput,
  readOnly: false,
  readOnlyForInput: (input) => input.op === 'list' || input.op === 'read',
  async execute(input, ctx) {
    const memDir = memoryDirOf(ctx.brainDir)
    if (input.op === 'list') {
      const files = walk(memDir).map((f) => relative(memDir, f).replaceAll('\\', '/'))
      return { output: files.length ? files.join('\n') : '(memory is empty)', isError: false }
    }
    if (input.op === 'remember') {
      if (!input.content?.trim()) return { output: 'remember requires content', isError: true }
      if (!input.speechAct) return { output: 'remember requires a speechAct classification', isError: true }
      const sourceRef = ctx.getCurrentUserSourceRef?.()
      if (!sourceRef) {
        return {
          output: 'Cannot remember this fact without a persisted user message; use an active persisted conversation.',
          isError: true,
        }
      }
      const scope = input.scope ?? 'global'
      if (scope === 'project' && !sourceRef.projectId) {
        return { output: 'Project-scoped memory requires a known persisted project source.', isError: true }
      }
      try {
        const memory = new MemoryHygieneStore(memDir).create({
          description: (input.description ?? input.content.split('\n')[0] ?? 'Remembered fact').slice(0, 256),
          content: input.content,
          sourceRefs: [sourceRef],
          observedAt: sourceRef.timestamp,
          ...(input.validFrom ? { validFrom: input.validFrom } : {}),
          ...(input.validUntil ? { validUntil: input.validUntil } : {}),
          scope,
          ...(scope === 'project' && sourceRef.projectId ? { projectId: sourceRef.projectId } : {}),
          speechAct: input.speechAct,
          captureMode: 'explicit',
          confidence: 1,
          sensitivity: input.sensitivity ?? 'ordinary',
        })
        return {
          output: `Active semantic memory saved: ${memory.memoryId} (linked to the current persisted user message).`,
          isError: false,
        }
      } catch (error) {
        return { output: `Could not save semantic memory: ${(error as Error).message}`, isError: true }
      }
    }
    if (input.op === 'review') {
      if (!input.memoryId || !input.decision) return { output: 'review requires memoryId and decision', isError: true }
      try {
        const store = new MemoryHygieneStore(memDir)
        const continuityStore = new ContinuityStore(join(ctx.brainDir, 'continuity'))
        const memory = reviewSemanticCandidate(
          store,
          continuityStore,
          join(ctx.brainDir, 'sessions'),
          input.memoryId,
          input.decision,
        )
        return { output: `Semantic memory ${memory.memoryId} reviewed: ${memory.status}.`, isError: false }
      } catch (error) {
        return { output: `Could not review semantic memory: ${(error as Error).message}`, isError: true }
      }
    }
    if (input.op === 'forget') {
      if (!input.memoryId) return { output: 'forget requires memoryId', isError: true }
      try {
        const forgotten = new MemoryHygieneStore(memDir).forget(input.memoryId)
        return { output: `Semantic memory forgotten: ${forgotten.memoryId}. Its source session remains available for historical recall.`, isError: false }
      } catch (error) {
        return { output: `Could not forget semantic memory: ${(error as Error).message}`, isError: true }
      }
    }
    if (input.op === 'supersede') {
      if (!input.memoryId || !input.content?.trim()) {
        return { output: 'supersede requires an active memoryId and replacement content', isError: true }
      }
      const sourceRef = ctx.getCurrentUserSourceRef?.()
      if (!sourceRef) {
        return {
          output: 'Cannot correct memory without a persisted user message; use an active persisted conversation.',
          isError: true,
        }
      }
      try {
        const store = new MemoryHygieneStore(memDir)
        const previous = store.get(input.memoryId)
        if (!previous || previous.status !== 'active') {
          return { output: `No active semantic memory ${input.memoryId} to correct.`, isError: true }
        }
        const replacement = store.supersede(input.memoryId, {
          description: (input.description ?? input.content.split('\n')[0] ?? previous.description).slice(0, 256),
          content: input.content,
          sourceRefs: [sourceRef],
          observedAt: sourceRef.timestamp,
          scope: previous.scope,
          ...(previous.projectId ? { projectId: previous.projectId } : {}),
          speechAct: 'corrected',
          captureMode: 'explicit',
          confidence: 1,
          sensitivity: previous.sensitivity,
        })
        return {
          output: `Semantic memory corrected; replacement ${replacement.memoryId} supersedes ${input.memoryId}.`,
          isError: false,
        }
      } catch (error) {
        return { output: `Could not correct semantic memory: ${(error as Error).message}`, isError: true }
      }
    }
    if (!input.path) return { output: `op ${input.op} requires path`, isError: true }
    const abs = safeResolve(memDir, input.path)
    if (!abs) return { output: `Path escapes memory dir: ${input.path}`, isError: true }
    const rel = relative(memDir, abs)
    const relPosix = rel.replaceAll('\\', '/')
    // MEMORY.md is the index this tool maintains; direct writes/deletes would corrupt it.
    const isIndex = rel.replaceAll('\\', '/').toLowerCase() === 'memory.md'
    if (isIndex && (input.op === 'write' || input.op === 'delete')) {
      return {
        output: 'MEMORY.md is the reserved index maintained by this tool; write facts to another file',
        isError: true,
      }
    }
    if (relPosix.toLowerCase().startsWith('semantic/') && (input.op === 'write' || input.op === 'delete')) {
      return {
        output: 'Managed semantic memories cannot be edited or deleted as free text; use their lifecycle actions.',
        isError: true,
      }
    }
    switch (input.op) {
      case 'read': {
        if (!existsSync(abs)) return { output: `No memory at ${rel}`, isError: true }
        if (relPosix.toLowerCase().startsWith('semantic/')) {
          const memoryId = relPosix.split('/').at(-1)!.replace(/\.md$/i, '')
          const memory = new MemoryHygieneStore(memDir).get(memoryId)
          if (!memory || memory.file.toLowerCase() !== abs.toLowerCase()) {
            return { output: `No managed semantic memory at ${rel}`, isError: true }
          }
          if (memory.forgottenAt) {
            return {
              output: 'Managed semantic memory was forgotten; its original source session remains available for historical recall.',
              isError: true,
            }
          }
          if (['candidate', 'flagged', 'rejected', 'tombstoned'].includes(memory.status)) {
            return {
              output: `Managed semantic memory is ${memory.status}; inspect it through local memory review controls.`,
              isError: true,
            }
          }
          const sourceAvailability = semanticSourcesAvailable(
            memory,
            join(ctx.brainDir, 'sessions'),
            join(ctx.brainDir, 'continuity'),
          )
          if (sourceAvailability !== 'available') {
            if (sourceAvailability === 'tombstone-corrupt') {
              return {
                output: 'Continuity tombstone ledger is corrupt; linked memory is suppressed. Restore a valid backup or repair tombstones.json, then run `athena memory rebuild`.',
                isError: true,
              }
            }
            return { output: 'Managed semantic memory source unavailable; inspect its linked source locally before using it.', isError: true }
          }
          return {
            output:
              `Status: ${memory.status}; scope: ${memory.scope}; speech act: ${memory.speechAct}; ` +
              `observed: ${memory.observedAt}; valid: ${memory.validFrom ?? 'unbounded'} to ${memory.validUntil ?? 'unbounded'}; ` +
              `confidence: ${memory.confidence}; sensitivity: ${memory.sensitivity}\n\n${memory.content}`,
            isError: false,
          }
        }
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
