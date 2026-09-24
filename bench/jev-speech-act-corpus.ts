import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { JEV_MEMORY_SPEECH_ACTS } from '../src/decision/jev.js'

const CorpusSchema = z.object({
  schemaVersion: z.literal(1),
  cases: z.array(z.object({
    id: z.string().min(1),
    speechAct: z.enum(JEV_MEMORY_SPEECH_ACTS),
    text: z.string().min(1),
  }).strict()).min(1),
}).strict()

export type JevSpeechActCorpus = z.infer<typeof CorpusSchema>

function loadCorpus(filename: string): JevSpeechActCorpus {
  const path = fileURLToPath(new URL(`../tests/fixtures/continuity/${filename}`, import.meta.url))
  return CorpusSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
}

export function loadJevSpeechActCorpus(): JevSpeechActCorpus {
  return loadCorpus('jev-speech-act.v1.json')
}

export function loadJevSpeechActHoldoutCorpus(): JevSpeechActCorpus {
  return loadCorpus('jev-speech-act-holdout.v1.json')
}

export function loadJevSpeechActIndependentHoldoutCorpus(): JevSpeechActCorpus {
  return loadCorpus('jev-speech-act-independent-holdout.v1.json')
}
