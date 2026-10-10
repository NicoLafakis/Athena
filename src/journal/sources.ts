import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { z } from 'zod'
import { projectId } from '../harness/trust.js'
import { redactSessionValue } from '../harness/redaction.js'
import { realPathForAccess } from '../harness/resource-policy.js'
import type { RunTraceEnvelope } from '../harness/traces.js'
import { JournalStore } from './store.js'
import { JOURNAL_LIMITS, JournalSourceSchema, digest, emptyChange, normalize, type JournalChange, type JournalSource } from './types.js'

const TraceSchema = z.object({
  schemaVersion: z.literal(1), runId: z.string().uuid(), parentRunId: z.string().uuid().nullable(),
  sequence: z.number().int().positive(), timestamp: z.string().datetime(), type: z.string(), payload: z.unknown(),
  previousHash: z.string().nullable(), hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
const RunMetadata = z.object({ cwd: z.string(), provider: z.string(), model: z.string() }).passthrough()
const EngineEvent = z.object({ type: z.string() }).passthrough()
const ToolRequest = z.object({ type: z.literal('tool-request'), id: z.string(), name: z.string(), input: z.unknown() }).passthrough()
const ToolResult = z.object({ type: z.literal('tool-result'), id: z.string(), name: z.string(), isError: z.boolean(), output: z.string() }).passthrough()
const traceRelative = /^[a-f0-9]{64}[/\\][0-9a-f-]{36}\.jsonl$/

/** Source text is data. Reject bodies/diffs, credentials and instruction-changing content. */
export function safeText(value: string, maxChars = 2000): string | null {
  if (value.length > maxChars || /```|-----BEGIN|(?:^|\n)(?:diff --git|@@|\+\+\+|---\s+\S|\s*(?:import|export|function|class)\s.+[;{])/.test(value)) return null
  if (/\b(?:ignore|override|bypass)\b.{0,60}\b(?:instructions?|policy|permissions?|sandbox)\b|\b(?:change|rewrite|disable|modify|update)\b.{0,60}\b(?:system prompt|constitution|permissions?|sandbox|ATHENA\.md|AGENTS\.md|settings\.json)\b/i.test(value)) return null
  if (/\b(?:password|api[_-]?key|authorization|private[_-]?key|secret)\s*[:=]|\b\d{3}-\d{2}-\d{4}\b|\b[^\s@]+@[^\s@]+\.[^\s@]+\b/i.test(value)) return null
  const redacted = redactSessionValue(value) as string
  return redacted.trim() || null
}
function label(value: string): string { return value.replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 80) }

export function readTrace(store: JournalStore, file: string): RunTraceEnvelope[] {
  file = realPathForAccess(file, store.root)
  const text = store.readBounded(file, JOURNAL_LIMITS.traceBytes)
  if (!text.endsWith('\n')) throw new Error('Trace is incomplete; journal preserves it without interpreting it')
  const lines = text.trimEnd().split('\n')
  if (lines.length > JOURNAL_LIMITS.traceEvents) throw new Error('Trace event bound exceeded')
  const events: RunTraceEnvelope[] = lines.map(line => {
    const parsed = TraceSchema.parse(JSON.parse(line))
    if (!Object.hasOwn(parsed, 'payload')) throw new Error('Trace payload is missing')
    return { ...parsed, payload: parsed.payload }
  })
  let previous: RunTraceEnvelope | undefined
  for (const [index, event] of events.entries()) {
    const { hash, ...base } = event
    if (event.sequence !== index + 1 || event.previousHash !== (previous?.hash ?? null) || digest(base) !== hash || (previous && (event.runId !== previous.runId || event.parentRunId !== previous.parentRunId))) throw new Error('Trace integrity validation failed')
    previous = event
  }
  const first = events[0]
  if (!first || first.type !== 'run-start') throw new Error('Missing trace metadata')
  const metadata = RunMetadata.parse(first.payload)
  const expected = join(store.root, '..', 'runs', projectId(metadata.cwd), `${first.runId}.jsonl`)
  if (expected !== file) throw new Error('Trace project/run identity does not match its source location')
  return events
}
function sourceFor(store: JournalStore, file: string, event: RunTraceEnvelope, scopeId: string, summary: string, inferred = false): JournalSource {
  const prompt = event.type === 'user-prompt' ? z.object({ prompt: z.string() }).parse(event.payload).prompt : null
  return {
    schemaVersion: 1, id: digest(`trace:${event.runId}:${event.hash}`), originId: prompt === null ? digest(`trace:${event.runId}:${event.hash}`) : digest(`assertion:${scopeId}:${normalize(prompt)}`),
    scopeId, kind: 'trace', evidenceKind: inferred ? 'inferred' : 'observed', file: relative(join(store.root, '..', 'runs'), file).split(sep).join('/'),
    revision: event.hash, sequence: event.sequence, runId: event.runId, timestamp: event.timestamp, summary: summary.slice(0, 280), toolVersion: 'athena-journal-v1',
    limitations: [inferred ? 'User-authored assertion, not independently verified.' : 'Observed trace metadata records what the harness/tool reported; it does not prove external behavior.', 'Hash validation establishes integrity, not truth.'],
  }
}

/** Pure reconstruction of bounded canonical metadata, independent of ledger assertions. */
function extractTrace(store: JournalStore, file: string, captureSince: string, events = readTrace(store, file)): JournalChange {
  file = realPathForAccess(file, store.root)
  const metadata = RunMetadata.parse(events[0]!.payload)
  const scopeId = projectId(metadata.cwd)
  const change = emptyChange()
  const requests = new Map<string, z.infer<typeof ToolRequest>>()
  const failures = new Map<string, string[]>()
  for (const event of events) {
    if (event.type === 'engine-event') {
      const e = EngineEvent.parse(event.payload)
      if (e.type === 'tool-request') { const request = ToolRequest.parse(e); requests.set(request.id, request) }
    }
    if (event.timestamp < captureSince) continue
    let source: JournalSource | undefined
    let interesting = false
    let evidence: string[] = []
    if (event.type === 'user-prompt') source = sourceFor(store, file, event, scopeId, 'User prompt recorded; its assertions remain unverified.', true)
    else if (event.type === 'engine-event') {
      const e = EngineEvent.parse(event.payload)
      if (e.type === 'tool-result') {
        const result = ToolResult.parse(e)
        if (result.name === 'Journal') continue // Generated reflection is never its own next input.
        const request = requests.get(result.id)
        if (!request || request.name !== result.name) continue
        source = sourceFor(store, file, event, scopeId, `Tool ${label(result.name)} reported ${result.isError ? 'failure' : 'success'}; output is retained in its original trace.`)
        source.operation = { name: label(result.name), inputHash: digest(request.input), failed: result.isError }
        const group = `${event.runId}:${source.operation.name}:${source.operation.inputHash}`
        const prior = failures.get(group) ?? []
        if (result.isError) failures.set(group, [...prior, source.id].slice(-16))
        else {
          if (prior.length >= 2) {
            source.summary = `Tool ${label(result.name)} reported recovery after ${prior.length} same-input failures; output behavior remains unverified.`
            interesting = true
            evidence = [...prior, source.id]
          }
          failures.delete(group)
        }
        const command = z.object({ command: z.string().optional() }).passthrough().safeParse(request.input)
        if (!result.isError && ['Bash', 'PowerShell'].includes(result.name) && /\bgit\s+commit\b/.test(command.success ? command.data.command ?? '' : '')) {
          interesting = true
          source.summary = 'Shell reported success for a git commit command; repository state has not been independently verified.'
        }
      } else if ((e.type === 'error' && e['fatal'] === true) || e.type === 'run-limit' || (e.type === 'child-status' && ['failed', 'aborted'].includes(String(e['status'])))) {
        source = sourceFor(store, file, event, scopeId, `${label(e.type)} recorded${e.type === 'child-status' ? `: child ${label(String(e['status']))}` : ''}; inspect the original trace for details.`)
        interesting = true
      } else if (e.type === 'turn-done') source = sourceFor(store, file, event, scopeId, 'A turn finished; completion text does not independently verify its claims.')
    }
    if (!source) continue
    source.provider = metadata.provider
    source.model = metadata.model
    source.captureSince = captureSince
    source.limitations.push('Original execution-tool version is unknown; toolVersion identifies the journal extractor, not that tool.')
    change.sources.push(source)
    if (interesting) change.entries.push({ schemaVersion: 1, id: digest(`entry:${source.id}`), timestamp: event.timestamp, type: 'trace', scopeId, runId: event.runId,
      author: 'system', subjective: false, evidenceKind: 'observed', sourceIds: evidence.length ? evidence : [source.id], text: source.summary })
  }
  return change
}

/** Extract only metadata from an actual canonical trace; original content stays in the trace. */
export function collectTrace(store: JournalStore, file: string, captureSince: string): JournalChange {
  const change = extractTrace(store, file, captureSince)
  // Keep a finite tail; recovery continues at later turns and sources already captured remain immutable.
  const stored = store.load().sources
  const pending = change.sources.filter(source => !stored.has(source.id)).slice(0, JOURNAL_LIMITS.captureBatch)
  const available = new Set([...stored.keys(), ...pending.map(source => source.id)])
  return { ...change, sources: pending, entries: change.entries.filter(entry => entry.sourceIds.every(id => available.has(id))).slice(0, JOURNAL_LIMITS.captureBatch) }
}

function memorySource(name: string, content: string, timestamp: string): JournalSource {
  const revision = digest(content)
  return { schemaVersion: 1, id: digest(`memory:${name}:${revision}`), originId: digest(`assertion:global:${normalize(content)}`), scopeId: 'global', kind: 'memory-file', evidenceKind: 'inferred', file: name, revision,
    timestamp, summary: `Manual memory file ${label(name)} was cataloged at a content revision; its statements remain unverified.`, toolVersion: 'athena-journal-v1', limitations: ['Existing memory content is an authored claim, not independent proof.', 'Content revisions invalidate affected interpretations.'] }
}

export interface SourceCheck { status: 'valid' | 'stale' | 'missing' | 'invalid'; excerpt?: string; limitation?: string }
export function checkSource(store: JournalStore, source: JournalSource): SourceCheck {
  try {
    source = JournalSourceSchema.parse(source)
    const root = join(store.root, '..', source.kind === 'trace' ? 'runs' : 'memory')
    if (source.kind === 'trace' ? !traceRelative.test(source.file) : source.file.length > 100 || !/^[^/\\:]+\.md$/i.test(source.file) || ['MEMORY.MD', 'LEARNED.MD'].includes(source.file.toUpperCase())) return { status: 'invalid', limitation: 'Invalid source location.' }
    const file = join(root, source.file)
    store.assertOwned(file)
    if (!existsSync(file)) return { status: 'missing', limitation: 'Original source is missing.' }
    if (source.kind === 'memory-file') {
      const content = store.readBounded(file, 50_000)
      if (digest(content) !== source.revision) return { status: 'stale', limitation: 'Memory source content revision changed.' }
      if (digest(source) !== digest(JournalSourceSchema.parse(memorySource(source.file, content, source.timestamp)))) return { status: 'invalid', limitation: 'Memory metadata does not match its original content revision.' }
      return { status: 'valid', excerpt: safeText(content.slice(0, 1600), 1600) ?? '(content withheld by journal filter)' }
    }
    if (!source.captureSince) return { status: 'invalid', limitation: 'Trace extraction window is missing.' }
    const events = readTrace(store, file)
    const canonical = extractTrace(store, file, source.captureSince, events).sources.find(item => item.sequence === source.sequence)
    if (!canonical || digest(source) !== digest(JournalSourceSchema.parse(canonical))) return { status: 'invalid', limitation: 'Trace metadata does not match the original record and extraction window.' }
    const event = events.find(item => item.sequence === source.sequence)
    if (!event || event.runId !== source.runId || event.hash !== source.revision || projectId(RunMetadata.parse(events[0]!.payload).cwd) !== source.scopeId) return { status: 'invalid', limitation: 'Trace origin no longer matches the referenced record.' }
    const prompt = event.type === 'user-prompt' ? z.object({ prompt: z.string() }).parse(event.payload).prompt : undefined
    return { status: 'valid', excerpt: prompt ? safeText(prompt.slice(0, 1600), 1600) ?? '(content withheld by journal filter)' : source.summary }
  } catch { return { status: 'invalid', limitation: 'Original source failed bounded integrity/access checks.' } }
}

/** Catalog existing manual memories by content revision. The generated namespace is excluded. */
export function collectMemoryFiles(store: JournalStore, now: Date): JournalChange {
  const change = emptyChange()
  const root = join(store.root, '..', 'memory')
  store.assertOwned(root)
  if (!existsSync(root)) return change
  const names = readdirSync(root)
  if (names.length > JOURNAL_LIMITS.directoryFiles) throw new Error('Memory directory exceeds journal catalog bound')
  const stored = store.load().sources
  const candidates = names.filter(name => name.length <= 100 && /\.md$/i.test(name) && !['MEMORY.MD', 'LEARNED.MD'].includes(name.toUpperCase())).sort()
  const cursorKey = digest('global-memory-catalog')
  const cursor = store.load().cursors.get(cursorKey) ?? ''
  const after = candidates.filter(name => name > cursor)
  const page = (after.length ? after : candidates).slice(0, JOURNAL_LIMITS.recoveryFiles)
  for (const name of page) {
    const file = join(root, name)
    store.assertOwned(file)
    if (!statSync(file).isFile()) continue
    const content = store.readBounded(file, 50_000)
    const source = memorySource(name, content, now.toISOString())
    if (!stored.has(source.id)) change.sources.push(source)
  }
  if (page.at(-1) && page.at(-1) !== cursor) change.recoveryCursor = { scopeId: cursorKey, file: page.at(-1)! }
  return change
}
export function captureKey(change: JournalChange): string { return `capture:${digest([change.sources.map(source => source.id), change.entries.map(entry => entry.id), change.recoveryCursor])}` }
export function hasChanges(change: JournalChange): boolean { return change.sources.length > 0 || change.entries.length > 0 || change.recoveryCursor !== undefined }
export function recoveryPage(store: JournalStore, cwd: string): { files: string[]; cursor?: string } {
  const scopeId = projectId(cwd)
  const root = join(store.root, '..', 'runs', scopeId)
  store.assertOwned(root)
  if (!existsSync(root)) return { files: [] }
  const names = readdirSync(root).filter(name => /^[0-9a-f-]{36}\.jsonl$/.test(name)).sort()
  if (names.length > JOURNAL_LIMITS.directoryFiles) throw new Error('Project trace directory exceeds journal recovery bound')
  const cursor = store.load().cursors.get(scopeId) ?? ''
  const after = names.filter(name => name > cursor)
  const page = (after.length ? after : names).slice(0, JOURNAL_LIMITS.recoveryFiles)
  return { files: page.map(name => join(root, name)), cursor: page.at(-1) ? basename(page.at(-1)!) : undefined }
}
