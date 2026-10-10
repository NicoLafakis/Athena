import { createHash, randomUUID } from 'node:crypto'
import type { z } from 'zod'
import type { ToolContext, ToolDefinition } from '../engine/types.js'
import { zodToJsonSchema } from '../engine/loop.js'
import { redactSessionValue } from '../harness/redaction.js'
import { ProtectedPaths } from '../harness/protected-paths.js'
import { readTool } from './read.js'
import { InvestigationLedger } from '../investigation/ledger.js'
import { captureRevision, digest, sourcePath, readSource } from '../investigation/source.js'
import { InvestigationInput, type InvestigationSnapshot, type InvestigationReport, type Observation } from '../investigation/types.js'
import { verifyInvestigation } from '../investigation/verification.js'

const LIMITATIONS = [
  'Only finite static source-text predicates are verified; statements and hypotheses are authored interpretations.',
  'No unit, runtime, external, graph, or binary provider is implemented. Hashes establish integrity, not truth.',
  'Scope covers declared files only. Matching names, comments, and strings do not establish reachability or causality.',
]

async function verificationFor(snapshot: InvestigationSnapshot, ctx: ToolContext) {
  const paths = snapshot.target.revision.files.map(f => f.path)
  const current = await captureRevision(ctx, paths)
  if (current.id !== snapshot.target.revision.id) return verifyInvestigation(snapshot, current)
  const sources = new Map<string, Buffer>()
  const observations: Observation[] = []
  for (const observation of snapshot.observations) {
    if (observation.kind !== 'observed' || !observation.location || !observation.usable) {
      observations.push(observation)
      continue
    }
    const location = observation.location
    let bytes = sources.get(location.path)
    try {
      if (!bytes) { bytes = await readSource(ctx, location.path); sources.set(location.path, bytes) }
      const hash = createHash('sha256').update(bytes).digest('hex')
      const text = bytes.toString('utf8').split(/\r?\n/).slice(location.firstLine - 1, location.lastLine).join('\n')
      observations.push({ ...observation,
        usable: location.lastLine >= location.firstLine && hash === location.fileHash && current.files.some(f => f.path === location.path && f.hash === hash) && text === observation.text && observation.tool.version === '1',
        independentIds: [digest({ sourceRevision: current.id, fileHash: hash })],
      })
    } catch {
      observations.push({ ...observation, usable: false })
    }
  }
  // A self-consistent ledger is not an oracle. Re-anchor retained observations to
  // the real bytes, and detect a revision moving during this check.
  const after = await captureRevision(ctx, paths)
  return verifyInvestigation({ ...snapshot, observations }, after)
}

async function report(snapshot: InvestigationSnapshot, ledger: InvestigationLedger, ctx: ToolContext): Promise<InvestigationReport> {
  const verification = await verificationFor(snapshot, ctx)
  const current = verification.currentRevision
  return {
    ...snapshot, verification, ledgerFile: ledger.file, ledgerIntegrity: 'valid',
    limitations: [...LIMITATIONS, ...(!current.gitHead ? ['Git revision unavailable; identity uses the declared file content hashes.'] : []), ...current.files.flatMap(file => file.problem ? [`${file.path}: ${file.problem}`] : [])],
  }
}

export function makeInvestigationTool(protectedPaths = ProtectedPaths.defaults()): ToolDefinition<z.infer<typeof InvestigationInput>> {
  // One registry instance is shared with durable children. Completion belongs to
  // the run that used the tool, never to its parent or the next ordinary turn.
  const active = new Map<string, Set<string>>()
  const activate = (ctx: ToolContext, id: string) => {
    const key = ctx.runId ?? 'local'
    const ids = active.get(key) ?? new Set<string>()
    if (ids.size >= 8 && !ids.has(id)) throw new Error('At most 8 investigations per turn')
    ids.add(id)
    active.set(key, ids)
  }
  const complete = async (id: string, ctx: ToolContext) => {
    const ledger = new InvestigationLedger(ctx, id, protectedPaths)
    const snapshot = await ledger.update(async current => {
      if (!current) throw new Error('Unknown investigation')
      return { ...current, verification: await verificationFor(current, ctx) }
    })
    return report(snapshot, ledger, ctx)
  }
  return {
    name: 'Investigation',
    description: 'Persist a bounded source investigation. start/read/note/submit/complete/result. Load Skill source-investigation for the contract. Only observed source-text predicates can pass; missing providers and revision changes remain explicit.',
    schema: InvestigationInput,
    // The existing converter handles object schemas, not discriminated unions.
    // Advertise each strict operation explicitly rather than an empty open object.
    inputSchemaJson: {
      type: 'object',
      properties: { op: { type: 'string', enum: InvestigationInput.options.map(option => option.shape.op.value) } },
      required: ['op'],
      anyOf: InvestigationInput.options.map(option => {
        const schema = zodToJsonSchema(option)
        const properties = schema.properties as Record<string, unknown>
        return { ...schema, additionalProperties: false, properties: { ...properties, op: { type: 'string', enum: [option.shape.op.value] } } }
      }),
    },
    readOnly: false, // Writes only the harness ledger; source reads use its resource policy.
    async execute(unchecked, ctx) {
      try {
        const input = InvestigationInput.parse(unchecked)
        const id = input.op === 'start' ? randomUUID() : input.id
        const pending = active.get(ctx.runId ?? 'local')
        if (pending && pending.size >= 8 && !pending.has(id)) throw new Error('At most 8 investigations per turn')
        const ledger = new InvestigationLedger(ctx, id, protectedPaths)
        if (input.op === 'complete') {
          const result = await complete(id, ctx)
          activate(ctx, id)
          return { output: JSON.stringify(result), isError: !result.verification.complete }
        }
        if (input.op === 'result') {
          const current = ledger.load()
          if (!current) throw new Error('Unknown investigation')
          const result = await report(current.snapshot, ledger, ctx)
          activate(ctx, id)
          return { output: JSON.stringify(result), isError: false }
        }
        const snapshot = await ledger.update(async current => {
          if (input.op === 'start') {
            if (current) throw new Error('Investigation already exists')
            const paths = input.files.map(file => sourcePath(ctx, file).path)
            if (new Set(paths.map(path => process.platform === 'win32' ? path.toLowerCase() : path)).size !== paths.length) throw new Error('Duplicate source file')
            return { schemaVersion: 1, id, version: 1, target: { question: input.question, cwd: ctx.cwd, revision: await captureRevision(ctx, paths) }, observations: [], result: null, verification: null }
          }
          if (!current) throw new Error('Unknown investigation')
          const revision = await captureRevision(ctx, current.target.revision.files.map(f => f.path))
          if (revision.id !== current.target.revision.id) throw new Error('Source revision is stale; start a new investigation')
          if (input.op === 'submit') {
            const result = redactSessionValue(input.result)
            if (digest(current.result) === digest(result)) return current
            if (current.version !== input.expectedVersion) throw new Error('Stale ledger version; reread result before updating')
            return { ...current, result: input.result, verification: null }
          }
          let observation: Observation
          if (input.op === 'read') {
            const file = sourcePath(ctx, input.file_path)
            const source = revision.files.find(f => f.path === file.path)
            if (!source?.hash) throw new Error('Source is missing, unsupported, or outside declared scope')
            const firstLine = input.offset ?? 1
            const limit = input.limit ?? 200
            const bytes = await readSource(ctx, file.path)
            if (createHash('sha256').update(bytes).digest('hex') !== source.hash) throw new Error('Source changed before the observation')
            const out = await readTool.execute({ file_path: file.path, offset: firstLine, limit }, ctx)
            if (out.isError) throw new Error(out.output)
            const lines = bytes.toString('utf8').split(/\r?\n/)
            if (lines.at(-1) === '') lines.pop()
            const selected = lines.slice(firstLine - 1, firstLine - 1 + limit)
            const text = selected.join('\n')
            const redacted = redactSessionValue(text) as string
            const rendered = [...out.output.matchAll(/^\s*\d+\t(.*)$/gm)].map(match => match[1]!).join('\n')
            const after = await captureRevision(ctx, revision.files.map(f => f.path))
            if (after.id !== revision.id) throw new Error('Source changed during the observation; no evidence retained')
            const identity = { sourceRevision: revision.id, path: file.path, firstLine, limit, textHash: digest(text), tool: 'Read/1' }
            observation = {
              id: digest(identity), kind: 'observed', sourceRevision: revision.id, tool: { name: 'Read', version: '1' },
              runId: ctx.runId ?? 'local', toolCallId: ctx.toolCallId ?? 'local',
              location: { path: file.path, firstLine, lastLine: selected.length ? firstLine + selected.length - 1 : 0, fileHash: source.hash },
              text: redacted.slice(0, 20_000), usable: selected.length > 0 && text.length <= 20_000 && rendered === text && redacted === text,
              parents: [], independentIds: [digest({ sourceRevision: revision.id, fileHash: source.hash })],
              limitations: ['Static source selection only; no execution or reachability proof', ...(rendered !== text || text.length > 20_000 ? ['Source selection was truncated or incomplete'] : []), ...(redacted !== text ? ['Source selection was redacted'] : []), ...(!selected.length ? ['Selected range is empty'] : [])],
            }
          } else {
            if (current.version !== input.expectedVersion) throw new Error('Stale ledger version; reread result before updating')
            const parents = input.evidenceIds.map(id => {
              const parent = current.observations.find(o => o.id === id)
              if (!parent) throw new Error(`Unknown evidence ${id}`)
              return parent
            })
            const text = redactSessionValue(input.statement) as string
            const limitations = redactSessionValue(input.limitations) as string[]
            observation = {
              id: digest({ kind: input.kind, sourceRevision: revision.id, text, parents: input.evidenceIds, limitations }),
              kind: input.kind, sourceRevision: revision.id, tool: { name: 'Investigation.note', version: '1' },
              runId: ctx.runId ?? 'local', toolCallId: ctx.toolCallId ?? 'local', location: null, text, usable: false,
              parents: input.evidenceIds, independentIds: [...new Set(parents.flatMap(o => o.independentIds))].sort(), limitations,
            }
          }
          if (current.observations.some(o => o.id === observation.id)) return current
          return { ...current, observations: [...current.observations, observation], verification: null }
        })
        activate(ctx, id)
        return { output: JSON.stringify(await report(snapshot, ledger, ctx)), isError: false }
      } catch (error) {
        return { output: `Investigation failed: ${(error as Error).message}`, isError: true }
      }
    },
    async completionCheck(ctx) {
      const key = ctx.runId ?? 'local'
      const ids = active.get(key)
      active.delete(key)
      if (!ids) return null
      const reasons: string[] = []
      for (const id of ids) {
        try {
          const result = await complete(id, ctx)
          if (!result.verification.complete) reasons.push(`Investigation ${id} not verified: claims ${result.verification.claims.map(c => `${c.id}=${c.status}`).join(', ') || 'no supported result'}; alternatives ${result.verification.hypotheses.map(h => `${h.id}=${h.status}`).join(', ') || 'not tested'}; ${result.verification.remainingUnknowns.length} remaining unknowns. Read Investigation result for the scope and limits.`)
        } catch (error) { reasons.push(`Investigation ${id} not verified: ${(error as Error).message}`) }
      }
      return reasons.length ? reasons.join('\n') : null
    },
  }
}
