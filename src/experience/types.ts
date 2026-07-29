import type { z } from 'zod'
import type { ExperienceRecordSchema, GuidanceRecordSchema } from './schemas.js'

export type ExperienceRecord = z.infer<typeof ExperienceRecordSchema>
export type GuidanceRecord = z.infer<typeof GuidanceRecordSchema>

export interface GuidanceMatch {
  guidance: GuidanceRecord
  experienceIds: string[]
  score: number
}

export interface GuidanceQuery {
  projectScope: string
  objective: string
  tags?: string[]
  limit?: number
  charBudget?: number
  minConfidence?: number
  maxAgeMs?: number
  now?: Date
}
