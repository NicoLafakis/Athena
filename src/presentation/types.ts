import type { PermissionAnswer, RunResult } from '../engine/types.js'
import type { Announcement, InteractionSnapshot } from '../interaction/types.js'

export interface PromptRequest {
  id: string
  label: string
}

export interface DetailRequest {
  id: string
  text: string
}

export interface PermissionDiffStats {
  addedLines: number
  removedLines: number
}

export interface AccessiblePermissionRequest {
  id: string
  toolName: string
  target: string
  consequence: string
  summary: string
  reason: string
  detailsCommand: string
  diff?: PermissionDiffStats
}

export interface InteractivePresentation {
  start(initial: InteractionSnapshot): Promise<void>
  announce(item: Announcement): void
  prompt(request: PromptRequest): Promise<string>
  requestPermission(request: AccessiblePermissionRequest): Promise<PermissionAnswer>
  showDetails(request: DetailRequest): void
  close(result: RunResult): Promise<void>
}
