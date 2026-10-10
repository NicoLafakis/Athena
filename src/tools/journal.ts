import { join } from 'node:path'
import { z } from 'zod'
import type { ToolDefinition } from '../engine/types.js'
import type { RunTraceWriter } from '../harness/traces.js'
import { projectId } from '../harness/trust.js'
import { realPathForAccess } from '../harness/resource-policy.js'
import { JournalRuntime } from '../journal/runtime.js'
import { checkSource, readTrace, safeText } from '../journal/sources.js'
import { digest, emptyChange, type JournalEntry } from '../journal/types.js'

const JournalInput = z.object({
  op: z.enum(['read', 'prediction', 'resolution', 'surprise', 'reflection']), text: z.string().min(1).max(2000).optional(),
  basis: z.string().min(1).max(2000).optional(), falsifiableBy: z.string().min(1).max(2000).optional(),
  predictionId: z.string().regex(/^[a-f0-9]{64}$/).optional(), outcome: z.enum(['confirmed', 'refuted', 'partial', 'unresolved']).optional(),
  expected: z.string().min(1).max(2000).optional(), whyItMatters: z.string().min(1).max(2000).optional(),
  traceHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict()

export function makeJournalTool(runtime: JournalRuntime, trace: RunTraceWriter): ToolDefinition<z.infer<typeof JournalInput>> {
  return {
    name: 'Journal', readOnly: false, schema: JournalInput,
    description: 'Read project journal/provenance or record a bounded prediction, evidence-linked resolution/surprise, or subjective reflection. Model interpretations always remain inferred. Cannot configure, schedule, promote claims, or change policy. Use a hash from this run for resolution/surprise; at most two reflections per run.',
    async execute(input, ctx) {
      try {
        if (!runtime.store.config().enabled) throw new Error('Journal is disabled; the user can enable it with athena journal enable')
        await trace.flush()
        runtime.capture(trace.file)
        const state = runtime.store.load()
        const scopeId = projectId(ctx.cwd)
        if (scopeId !== projectId(runtime.cwd)) throw new Error('Journal tool is scoped to its controller project')
        if (input.op === 'read') return { output: JSON.stringify({ entries: [...state.entries.values()].filter(entry => entry.scopeId === scopeId).slice(-20),
          sources: [...state.sources.values()].filter(source => source.scopeId === scopeId && source.runId === ctx.runId).slice(-24).map(source => ({ ...source, sourceStatus: checkSource(runtime.store, source).status })), memories: runtime.memoryView() }), isError: false }
        if (!input.text || !safeText(input.text) || [input.basis, input.falsifiableBy, input.expected, input.whyItMatters].some(value => value !== undefined && !safeText(value))) throw new Error('Journal note is missing text or was filtered as sensitive/instruction/body content')
        input = { ...input, text: safeText(input.text)!, ...(input.basis ? { basis: safeText(input.basis)! } : {}),
          ...(input.falsifiableBy ? { falsifiableBy: safeText(input.falsifiableBy)! } : {}), ...(input.expected ? { expected: safeText(input.expected)! } : {}), ...(input.whyItMatters ? { whyItMatters: safeText(input.whyItMatters)! } : {}) }
        const now = new Date().toISOString()
        const file = join(runtime.store.root, '..', 'runs', scopeId, `${ctx.runId}.jsonl`)
        if (ctx.runId !== trace.runId || file !== realPathForAccess(trace.file, ctx.cwd)) throw new Error('Journal notes must belong to the executing run')
        const sources = input.traceHash ? [...state.sources.values()].filter(source => source.runId === ctx.runId && source.revision === input.traceHash && checkSource(runtime.store, source).status === 'valid') : []
        if (input.traceHash && !sources.length) throw new Error('Evidence hash is not an eligible original record in this run')
        if ((input.op === 'resolution' || input.op === 'surprise') && !sources.length) throw new Error('Resolution/surprise requires a verified original trace reference')
        const base = { schemaVersion: 1 as const, id: digest(`note:${ctx.runId}:${digest(input)}`), timestamp: now, scopeId, runId: ctx.runId, author: 'model' as const,
          subjective: true, evidenceKind: 'inferred' as const, sourceIds: sources.map(source => source.id), text: input.text! }
        const existing = state.entries.get(base.id)
        if (existing) return { output: JSON.stringify(existing), isError: false }
        if (input.op === 'reflection' && [...state.entries.values()].filter(entry => entry.type === 'reflection' && entry.runId === ctx.runId).length >= 2) throw new Error('Two-reflection run budget reached')
        let entry: JournalEntry
        switch (input.op) {
          case 'prediction':
            if (!input.basis || !input.falsifiableBy) throw new Error('Prediction requires basis and falsifiableBy')
            entry = { ...base, type: 'prediction', basis: input.basis, falsifiableBy: input.falsifiableBy }
            break
          case 'resolution': {
            const prediction = state.entries.get(input.predictionId ?? '')
            if (!prediction || prediction.type !== 'prediction' || prediction.scopeId !== scopeId || !input.outcome) throw new Error('Resolution requires an existing same-project prediction and outcome')
            if (sources.some(source => source.timestamp <= prediction.timestamp)) throw new Error('Resolution evidence must follow the pre-recorded prediction')
            // Check the actual origin again; a hash links a claim to evidence, it does not score truth.
            readTrace(runtime.store, file)
            entry = { ...base, type: 'resolution', predictionId: prediction.id, outcome: input.outcome }
            break
          }
          case 'surprise':
            if (!input.expected || !input.whyItMatters) throw new Error('Surprise requires expected and whyItMatters')
            entry = { ...base, type: 'surprise', expected: input.expected, whyItMatters: input.whyItMatters }
            break
          case 'reflection': entry = { ...base, type: 'reflection' }; break
          default: throw new Error('Unknown journal note type')
        }
        runtime.store.commit(`note:${entry.id}`, { ...emptyChange(), entries: [entry] })
        return { output: JSON.stringify(entry), isError: false }
      } catch (error) { return { output: (error as Error).message, isError: true } }
    },
  }
}
