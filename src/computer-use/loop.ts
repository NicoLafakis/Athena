import { sha256Text } from '../harness/hash.js'
import { evaluateComputerUsePolicy, type ComputerTargetSurface } from './policy.js'
import type { ComputerAction, ComputerBackend } from './windows-backend.js'

export const COMPUTER_USE_MODEL = 'gpt-5.6'

export interface ComputerCallItem {
  callId: string
  actions: ComputerAction[]
}

export interface ComputerUseResponse {
  id: string
  computerCalls: ComputerCallItem[]
  outputText: string
  usage: {
    inputTokens: number
    outputTokens: number
  }
}

export interface ComputerUseRequest {
  model: string
  objective?: string
  previousResponseId?: string
  callOutput?: {
    callId: string
    screenshotBase64: string
    detail: 'original'
  }
  signal?: AbortSignal
}

export interface ComputerUseResponsesClient {
  create(request: ComputerUseRequest): Promise<ComputerUseResponse>
}

export interface ComputerUseTelemetry {
  model: string
  steps: number
  actionBatches: number
  inputTokens: number
  outputTokens: number
  wallTimeMs: number
  /** SHA-256 hex digests of captured screenshots; raw images are never persisted. */
  screenshotDigests: string[]
}

export interface ComputerUseResult {
  status: 'completed' | 'denied' | 'aborted' | 'limit-reached' | 'unavailable' | 'error'
  summary: string
  denyReason?: string
  denyRule?: string
  telemetry: ComputerUseTelemetry
}

export interface RunComputerUseLoopOptions {
  objective: string
  targetSurface: ComputerTargetSurface
  allowFullDesktop: boolean
  maxSteps?: number
  maxTotalTokens?: number
  model?: string
  client: ComputerUseResponsesClient
  backend: ComputerBackend
  signal?: AbortSignal
}

/**
 * Bounded actuator loop for OpenAI's GA `{ type: 'computer' }` tool on `gpt-5.6`.
 * Athena owns the loop, hard deny-list enforcement, step/token ceilings, kill switch,
 * and digest-only screenshot telemetry.
 */
export async function runComputerUseLoop(
  options: RunComputerUseLoopOptions,
): Promise<ComputerUseResult> {
  const startedAt = Date.now()
  const model = options.model ?? COMPUTER_USE_MODEL
  const maxSteps = Math.max(1, options.maxSteps ?? 12)
  const maxTotalTokens = Math.max(1_000, options.maxTotalTokens ?? 100_000)
  const telemetry: ComputerUseTelemetry = {
    model,
    steps: 0,
    actionBatches: 0,
    inputTokens: 0,
    outputTokens: 0,
    wallTimeMs: 0,
    screenshotDigests: [],
  }

  const finish = (
    status: ComputerUseResult['status'],
    summary: string,
    extra: { denyReason?: string; denyRule?: string } = {},
  ): ComputerUseResult => {
    telemetry.wallTimeMs = Math.max(0, Date.now() - startedAt)
    return { status, summary, ...extra, telemetry }
  }

  if (options.signal?.aborted) {
    return finish('aborted', 'Computer use aborted before start.')
  }

  const initialWindow = await options.backend.getActiveWindowTitle(options.signal)
  const preflight = evaluateComputerUsePolicy({
    objective: options.objective,
    targetSurface: options.targetSurface,
    allowFullDesktop: options.allowFullDesktop,
    windowTitle: initialWindow,
  })
  if (!preflight.allowed) {
    return finish('denied', preflight.reason, {
      denyReason: preflight.reason,
      denyRule: preflight.rule,
    })
  }

  let previousResponseId: string | undefined
  let pendingCallOutput: ComputerUseRequest['callOutput']

  for (;;) {
    if (options.signal?.aborted) {
      return finish('aborted', 'Computer use aborted by kill switch.')
    }

    const response = await options.client.create({
      model,
      ...(previousResponseId ? { previousResponseId } : { objective: options.objective }),
      ...(pendingCallOutput ? { callOutput: pendingCallOutput } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    })
    telemetry.inputTokens += response.usage.inputTokens
    telemetry.outputTokens += response.usage.outputTokens
    previousResponseId = response.id

    if (response.computerCalls.length === 0) {
      return finish('completed', response.outputText || 'Computer use completed with no further actions.')
    }

    if (telemetry.steps >= maxSteps) {
      return finish('limit-reached', `Stopped after reaching step ceiling (${maxSteps}).`)
    }
    if (telemetry.inputTokens + telemetry.outputTokens >= maxTotalTokens) {
      return finish('limit-reached', `Stopped after reaching token ceiling (${maxTotalTokens}).`)
    }

    const call = response.computerCalls[0]!
    telemetry.steps++
    telemetry.actionBatches++

    for (const action of call.actions) {
      if (options.signal?.aborted) {
        return finish('aborted', 'Computer use aborted between actions.')
      }
      const activeTitle = await options.backend.getActiveWindowTitle(options.signal)
      const stepVerdict = evaluateComputerUsePolicy({
        objective: options.objective,
        targetSurface: options.targetSurface,
        allowFullDesktop: options.allowFullDesktop,
        windowTitle: activeTitle,
        ...(action.type === 'type' ? { typedText: action.text } : {}),
      })
      if (!stepVerdict.allowed) {
        return finish('denied', stepVerdict.reason, {
          denyReason: stepVerdict.reason,
          denyRule: stepVerdict.rule,
        })
      }
      await options.backend.executeAction(action, options.signal)
    }

    const png = await options.backend.captureScreenshot(options.signal)
    const base64 = png.toString('base64')
    telemetry.screenshotDigests.push(sha256Text(base64))
    pendingCallOutput = {
      callId: call.callId,
      screenshotBase64: base64,
      detail: 'original',
    }
  }
}
