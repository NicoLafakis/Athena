import { safeDetailText } from '../presentation/action-details.js'

export interface ToolDisplay {
  name: string; input: unknown; output: string | null; isError: boolean; completed?: boolean
}

export function toolDisplayText(entry: ToolDisplay): string {
  const input = entry.input as Record<string, unknown> | null
  const summary = safeDetailText(String(input?.['command'] ?? input?.['file_path'] ?? input?.['pattern'] ?? ''))
  const short = Array.from(summary).slice(0, 60).join('')
  const state = entry.completed === false || entry.output === null ? 'running' : entry.isError ? 'failed' : 'finished'
  const first = safeDetailText(entry.output?.split('\n')[0] ?? '')
  return `⚙ ${entry.name}(${short}${summary.length > short.length ? '…' : ''}) [${state}]${first ? ` → ${first}` : ''}`
}
