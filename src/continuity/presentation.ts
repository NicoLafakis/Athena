import type { ContinuityEpisode, TimeRollup } from './schemas.js'
import type { ContinuityStore } from './store.js'
import { loadEpisodeSourceContext, searchEpisodes } from './retrieval.js'
import { resolveTemporalWindow } from './time.js'

export function formatContinuityStatus(store: ContinuityStore): string {
  const status = store.status()
  if (status.state === 'missing') return 'Continuity index: not built. Run `athena memory rebuild`.'
  if (status.state === 'corrupt') return 'Continuity index: corrupt. Run `athena memory rebuild` to recover it.'
  const prefix = status.state === 'partial' ? 'partial' : 'ready'
  return `Continuity index: ${prefix} (${status.episodeCount} episode(s), ${status.projectCount} project(s); built ${status.generatedAt}).`
}

export function formatContinuityRollups(
  store: ContinuityStore,
  configuredTimeZone?: string,
  granularity?: TimeRollup['granularity'],
): string {
  let timeZone = configuredTimeZone
  const inferredTimeZone = timeZone === undefined
  if (!timeZone) {
    try {
      timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    } catch {
      return 'Could not determine a timezone for time rollups. Set the global timeZone in ~/.athena/settings.json.'
    }
  }
  const result = store.buildRollups(timeZone, granularity ? [granularity] : undefined)
  if (result.state === 'missing') return 'Continuity index: not built. Run `athena memory rebuild`.'
  if (result.state === 'corrupt') return 'Continuity index: corrupt. Run `athena memory rebuild` to recover it.'
  if (result.state === 'partial') {
    return 'Continuity index is partial; rebuild the local session catalog before generating historical rollups.'
  }
  if (result.rollups.length === 0) return 'No source-linked episodes are available for time rollups.'

  const chosen = granularity
    ? result.rollups
        .filter((item) => item.granularity === granularity)
        .slice(-rollupLimit(granularity))
    : ['day', 'week', 'month', 'quarter', 'year'].flatMap((kind) => {
        const latest = result.rollups.filter((item) => item.granularity === kind).at(-1)
        return latest ? [latest] : []
      })
  if (chosen.length === 0) return `No ${granularity} rollups are available in the local index.`
  const timezoneLabel = inferredTimeZone ? `${timeZone} (OS timezone inferred)` : timeZone
  return [
    `Source-linked time rollups (${timezoneLabel}; summaries are bounded episode views):`,
    ...chosen.map(formatRollup),
  ].join('\n\n')
}

function rollupLimit(granularity: TimeRollup['granularity']): number {
  switch (granularity) {
    case 'day':
      return 7
    case 'week':
      return 8
    case 'month':
      return 12
    case 'quarter':
      return 8
    case 'year':
      return 5
  }
}

function formatRollup(rollup: TimeRollup): string {
  const visibleIds = rollup.sourceEpisodeIds.slice(0, 5)
  const remaining = rollup.sourceEpisodeIds.length - visibleIds.length
  const sourceLine = 'Sources: ' + visibleIds.join(', ') +
    (remaining > 0 ? ' (+' + remaining + ' more)' : '') +
    '; inspect with athena memory show <episode-id>.'
  return rollup.granularity.toUpperCase() + ' [' + rollup.periodStart + ', ' + rollup.periodEnd + ') ' +
    '(' + rollup.sourceEpisodeIds.length + ' episode(s), ' + rollup.sourceDigest.slice(0, 12) + '):\n' +
    sourceLine + '\n' + rollup.summary
}

export function formatContinuitySearch(
  store: ContinuityStore,
  sessionsRoot: string,
  options: { action: 'timeline' | 'search'; query: string; projectId?: string; timeZone?: string },
): string {
  const query = options.action === 'timeline' ? options.query || 'today' : options.query
  let window
  if (query) {
    const resolution = resolveTemporalWindow(query, {
      ...(options.timeZone ? { configuredTimeZone: options.timeZone } : {}),
    })
    if (resolution.status === 'resolved') window = resolution.window
    else if (resolution.reason !== 'no-bounded-window') return `Please clarify the requested time range: ${resolution.message}`
  }
  const hits = searchEpisodes(store.listEpisodes(), {
    text: options.action === 'timeline' ? '' : query,
    ...(window ? { window } : {}),
    ...(options.projectId ? { projectId: options.projectId } : {}),
    limit: 8,
  })
  const available = hits.flatMap((hit) => {
    const context = loadEpisodeSourceContext(sessionsRoot, hit.episode)
    return context.status === 'ok' ? [context.episode] : []
  })
  if (available.length === 0) return 'No source-verified conversation episodes matched that request.'
  return available.map((episode) => formatEpisodeListItem(episode)).join('\n')
}

export function formatContinuityEpisode(
  store: ContinuityStore,
  sessionsRoot: string,
  episodeId: string,
): string {
  const episode = store.listEpisodes().find((item) => item.id === episodeId)
  if (!episode) return `No indexed episode ${episodeId}`
  const context = loadEpisodeSourceContext(sessionsRoot, episode, 8, true)
  if (context.status !== 'ok') return `Episode source ${context.status}: ${context.reason}`
  const lines = [
    `${episode.id} — ${episode.observedAt} (${episode.timeZone ?? 'timezone inferred'})`,
    `Project: ${episode.projectId}`,
    `Status: ${episode.completion}; speech acts: ${episode.speechActs.join(', ') || '(unclassified)'}`,
    `Topics: ${episode.topics.join(', ') || '(none)'}`,
    `Summary: ${episode.summary}`,
    `Source lines: ${context.sourceRefs.map((ref) => ref.recordId).join(', ')}`,
    'Source messages:',
    ...context.messages.map((message) =>
      `[${message.timestamp}; ${message.sourceLineId}] ${message.role}: ${typeof message.content === 'string' ? message.content : JSON.stringify(message.content)}`,
    ),
  ]
  if (context.adjacentMessages.length > 0) {
    lines.push('Adjacent conversation context:')
    lines.push(...context.adjacentMessages.map((message) =>
      `[${message.relation}; ${message.timestamp}; ${message.sourceLineId}] ${message.role}: ${typeof message.content === 'string' ? message.content : JSON.stringify(message.content)}`,
    ))
  }
  if (context.truncated) lines.push('(conversation context truncated to the eight-message inspection limit)')
  return lines.join('\n')
}

function formatEpisodeListItem(episode: ContinuityEpisode): string {
  return `${episode.observedAt}\t${episode.projectId}\t${episode.id}\t${episode.summary}`
}
