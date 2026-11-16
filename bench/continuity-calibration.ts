import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { ContinuityStore } from '../src/continuity/store.js'
import { formatContinuitySearch } from '../src/continuity/presentation.js'
import { rankContinuityLayers } from '../src/continuity/ranking.js'
import { loadEpisodeSourceContexts, searchEpisodes } from '../src/continuity/retrieval.js'
import { SessionStore } from '../src/harness/sessions.js'

const EPISODE_COUNT = 10_000
const SAMPLE_COUNT = 10
const now = new Date('2026-09-23T12:00:00.000Z')

function syntheticIndex() {
  const episodes = Array.from({ length: EPISODE_COUNT }, (_, index) => {
    const projectId = `project-${index % 4}`
    const sessionId = `session-${index}`
    const observedAt = new Date(now.getTime() - index * 60_000).toISOString()
    return {
      schemaVersion: 1,
      id: `episode-${index}`,
      sourceRefs: [{
        kind: 'session-message',
        projectId,
        sessionId,
        recordId: `line-${index}`,
        timestamp: observedAt,
        timeZone: 'UTC',
      }],
      projectId,
      sessionId,
      observedAt,
      localDate: observedAt.slice(0, 10),
      timeZone: 'UTC',
      participants: ['user', 'assistant'],
      topics: ['continuity', 'memory'],
      summary: index % 10 === 0
        ? 'The user decided to keep source linked continuity memory.'
        : 'The user discussed the project schedule.',
      sourceDigest: 'a'.repeat(64),
      speechActs: ['decided'],
      completion: 'completed',
      createdAt: observedAt,
    }
  })
  const sessions = episodes.map((episode) => ({
    projectId: episode.projectId,
    sessionId: episode.sessionId,
    sourceDigest: 'b'.repeat(64),
    canonicalLineCount: 3,
  }))
  return { schemaVersion: 1, generatedAt: now.toISOString(), catalogComplete: true, sessions, episodes }
}

function samples(run: () => void): { medianMs: number; minMs: number; maxMs: number } {
  const values: number[] = []
  for (let index = 0; index < SAMPLE_COUNT; index++) {
    const started = performance.now()
    run()
    values.push(performance.now() - started)
  }
  values.sort((left, right) => left - right)
  return {
    medianMs: Number(((values[4]! + values[5]!) / 2).toFixed(2)),
    minMs: Number(values[0]!.toFixed(2)),
    maxMs: Number(values.at(-1)!.toFixed(2)),
  }
}

const root = mkdtempSync(join(tmpdir(), 'athena-continuity-bench-'))
try {
  const continuityDir = join(root, 'continuity')
  mkdirSync(continuityDir)
  const index = syntheticIndex()
  const expandedIndex = JSON.stringify(index, null, 2) + '\n'
  const serialized = JSON.stringify({
    format: 'athena-continuity-index',
    formatVersion: 1,
    encoding: 'gzip+base64',
    payload: gzipSync(Buffer.from(expandedIndex, 'utf8')).toString('base64'),
  }) + '\n'
  writeFileSync(join(continuityDir, 'index.json'), serialized, 'utf8')
  const store = new ContinuityStore(continuityDir)

  const coldStart = performance.now()
  store.status()
  store.listEpisodes()
  const coldValidateMs = Number((performance.now() - coldStart).toFixed(2))

  const warmSearch = samples(() => {
    searchEpisodes(store.listEpisodes(), { text: 'continuity memory' })
  })
  const warmRankingWithRollups = samples(() => {
    const status = store.status()
    const rollups = status.state === 'ready' ? store.buildRollups('UTC').rollups : []
    rankContinuityLayers({
      query: 'What did we decide about continuity memory?',
      episodes: store.listEpisodes(),
      rollups,
      now,
    })
  })

  const sourceRoot = join(root, 'source-sessions')
  for (let index = 0; index < 5; index++) {
    const sessionStore = new SessionStore(sourceRoot, `C:/synthetic/project-${index % 2}`)
    const session = sessionStore.create()
    session.appendMessage({ role: 'user', content: `I decided to keep a synthetic source-linked continuity item ${index}.` })
    session.appendMessage({ role: 'assistant', content: `The item ${index} remains linked to the source.` })
    session.appendEvent({ type: 'turn-done' })
  }
  const contextStore = new ContinuityStore(join(root, 'context-index'))
  contextStore.rebuild(sourceRoot)
  const contextEpisodes = contextStore.listEpisodes()
  const projectIds = [...new Set(contextEpisodes.map((episode) => episode.projectId).filter((id): id is string => id !== null))]
  for (let index = 0; index < EPISODE_COUNT - contextEpisodes.length; index++) {
    const projectId = projectIds[index % projectIds.length]!
    writeFileSync(join(sourceRoot, projectId, `filler-${index}.jsonl`), '', 'utf8')
  }
  const sourceContextExpansion = samples(() => {
    loadEpisodeSourceContexts(sourceRoot, contextEpisodes)
  })
  const warmSearchWithSourceContexts = samples(() => {
    formatContinuitySearch(contextStore, sourceRoot, {
      action: 'search',
      query: 'synthetic continuity',
      timeZone: 'UTC',
    })
  })

  process.stdout.write(JSON.stringify({
    fixture: 'synthetic-local-index',
    episodes: EPISODE_COUNT,
    indexBytes: Buffer.byteLength(serialized, 'utf8'),
    expandedIndexBytes: Buffer.byteLength(expandedIndex, 'utf8'),
    storedToExpandedIndexPercent: Number((Buffer.byteLength(serialized, 'utf8') /
      Buffer.byteLength(expandedIndex, 'utf8') * 100).toFixed(2)),
    samplesPerWarmPath: SAMPLE_COUNT,
    coldValidateMs,
    warmSearch,
    warmRankingWithRollups,
    syntheticSessionFiles: EPISODE_COUNT,
    sourceContextEpisodes: contextEpisodes.length,
    sourceContextExpansion,
    warmSearchWithSourceContexts,
    note: 'All data is generated under a temporary directory; no user archive is read.',
  }, null, 2) + '\n')
} finally {
  rmSync(root, { recursive: true, force: true })
}
