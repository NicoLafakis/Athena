import { compileExperienceFromTrace, deriveProvisionalGuidance } from './compiler.js'
import { ExperienceStore } from './store.js'
import type { ExperienceRecord, GuidanceRecord } from './types.js'

export interface CapturedExperience {
  experience: ExperienceRecord
  guidance: GuidanceRecord
}

/** Capture is an optional post-run improvement. It must never change run success,
 * startup, or shutdown behavior when a trace or experience index is unavailable. */
export async function captureExperienceBestEffort(
  traceFile: string,
  store: ExperienceStore,
  onWarn?: (warning: string) => void,
): Promise<CapturedExperience | null> {
  try {
    const experience = await compileExperienceFromTrace(traceFile)
    const guidance = deriveProvisionalGuidance(experience)
    store.appendExperience(experience)
    if (!store.listGuidance().some((record) => record.id === guidance.id)) {
      store.appendGuidance(guidance)
    }
    return { experience, guidance }
  } catch {
    onWarn?.(
      `Experience capture skipped for ${traceFile}; the completed run is unchanged. Run \`athena experience rebuild\` to recover the optional index.`,
    )
    return null
  }
}
