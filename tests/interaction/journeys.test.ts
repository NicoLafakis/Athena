import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { SEMANTIC_VOCABULARY, VOCABULARY_VERSION } from '../../src/interaction/vocabulary.js'

const CapabilitySchema = z.enum([
  'auth',
  'broad-objective',
  'status',
  'tools',
  'permission',
  'child',
  'background',
  'failure',
  'interrupt',
  'resume',
  'completion',
])

const JourneyFixtureSchema = z.object({
  schemaVersion: z.literal(1),
  provenance: z.string().min(1).max(512),
  journeys: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    title: z.string().min(1).max(160),
    researchStatus: z.literal('proxy-baseline'),
    capabilities: z.array(CapabilitySchema).min(1),
    steps: z.array(z.object({
      actor: z.enum(['user', 'runtime', 'athena']),
      action: z.string().min(1).max(512),
      expectedSemantic: z.string().min(1).max(512),
    }).strict()).min(2).max(32),
  }).strict()).min(1).max(20),
}).strict()

describe('blind-first core journey fixtures', () => {
  it('records every required baseline capability without claiming human validation', () => {
    const file = join(process.cwd(), 'tests', 'fixtures', 'interaction', 'core-journeys.json')
    const fixture = JourneyFixtureSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
    const ids = fixture.journeys.map((journey) => journey.id)
    expect(new Set(ids).size).toBe(ids.length)
    const covered = new Set(fixture.journeys.flatMap((journey) => journey.capabilities))
    expect([...covered].sort()).toEqual([...CapabilitySchema.options].sort())
    expect(fixture.journeys.every((journey) => journey.researchStatus === 'proxy-baseline')).toBe(true)
  })
})

describe('semantic vocabulary fixture', () => {
  it('uses seven unique plain-language labels whose definitions do not depend on visuals', () => {
    expect(VOCABULARY_VERSION).toBe(1)
    expect(Object.keys(SEMANTIC_VOCABULARY).sort()).toEqual([
      'advisory',
      'attention',
      'blocked',
      'completed',
      'failed',
      'permission',
      'status',
    ])
    const entries = Object.values(SEMANTIC_VOCABULARY)
    expect(new Set(entries.map((entry) => entry.label)).size).toBe(entries.length)
    expect(new Set(entries.map((entry) => entry.definition)).size).toBe(entries.length)
    for (const entry of entries) {
      expect(entry.label).toMatch(/^[A-Z][a-z]+$/)
      expect(entry.definition).not.toMatch(/\b(color|icon|panel|position|screen|visual)\b/i)
      expect(entry.definition.length).toBeLessThanOrEqual(240)
    }
  })
})
