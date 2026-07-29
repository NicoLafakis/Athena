import type { EngineEvent } from '../../engine/types.js'

export interface WorkAggregate {
  activeChildren: number
  activeBackground: number
  total: number
  label: string
}

export interface WorkAggregationDetectorOptions {
  maxChildren?: number
  maxBackground?: number
}

function trimOldest(values: Map<string, true>, max: number): void {
  while (values.size > max) {
    const oldest = values.keys().next().value as string | undefined
    if (oldest === undefined) return
    values.delete(oldest)
  }
}

function noun(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

export class WorkAggregationDetector {
  private readonly children = new Map<string, true>()
  private readonly background = new Map<string, true>()
  private readonly maxChildren: number
  private readonly maxBackground: number
  private lastCounts = ''

  constructor(options: WorkAggregationDetectorOptions = {}) {
    this.maxChildren = Math.max(1, options.maxChildren ?? 256)
    this.maxBackground = Math.max(1, options.maxBackground ?? 256)
  }

  accept(event: EngineEvent): WorkAggregate | null {
    if (event.type === 'child-status') {
      if (event.status === 'running') {
        this.children.set(event.runId, true)
        trimOldest(this.children, this.maxChildren)
      } else {
        this.children.delete(event.runId)
      }
    } else if (event.type === 'background-status') {
      if (event.status === 'running') {
        this.background.set(event.taskId, true)
        trimOldest(this.background, this.maxBackground)
      } else {
        this.background.delete(event.taskId)
      }
    } else {
      return null
    }

    const activeChildren = this.children.size
    const activeBackground = this.background.size
    const counts = `${activeChildren}:${activeBackground}`
    if (counts === this.lastCounts) return null
    this.lastCounts = counts
    const total = activeChildren + activeBackground
    return {
      activeChildren,
      activeBackground,
      total,
      label: total === 0
        ? 'No active delegated work'
        : `${noun(total, 'active task')}: ${noun(activeChildren, 'child', 'children')}, ${noun(activeBackground, 'background', 'background')}`,
    }
  }

  stats(): { activeChildren: number; activeBackground: number } {
    return { activeChildren: this.children.size, activeBackground: this.background.size }
  }
}
