import { z } from 'zod'
import {
  probeComputerUseBackend,
  runComputerUseLoop,
  type ComputerBackend,
  type ComputerUseResponsesClient,
} from '../computer-use/index.js'
import type { ToolDefinition } from '../engine/types.js'

const ComputerUseInput = z.object({
  objective: z.string().min(1).max(2_000),
  targetSurface: z.enum(['browser', 'window', 'desktop']).optional(),
  allowFullDesktop: z.boolean().optional(),
  maxSteps: z.number().int().min(1).max(30).optional(),
  maxTotalTokens: z.number().int().min(1_000).max(250_000).optional(),
})

export interface MakeComputerUseToolOptions {
  client?: ComputerUseResponsesClient
  backend?: ComputerBackend
}

/**
 * Bounded GUI actuator tool (OpenAI GA `{ type: 'computer' }` on `gpt-5.6`).
 * Never becomes a top-level agent; subject to PermissionEngine, ResourcePolicy,
 * independent hard deny-list, step/token ceilings, and digest-only screenshot telemetry.
 */
export function makeComputerUseTool(
  options: MakeComputerUseToolOptions = {},
): ToolDefinition<z.infer<typeof ComputerUseInput>> {
  return {
    name: 'ComputerUse',
    description:
      'Execute a bounded GUI objective on a scoped browser or window surface using OpenAI GA computer use (gpt-5.6). Never use when a CLI path exists. Subject to an independent hard deny list (vault/credentials, password managers, banking/payments, UAC/Defender, CAPTCHAs, email send) regardless of permission mode.',
    schema: ComputerUseInput,
    readOnly: false,
    async execute(input, ctx) {
      if (!options.client || !options.backend) {
        const probe = probeComputerUseBackend()
        return {
          output:
            `ComputerUse is not activated in this session (backend=${probe.backend}, available=${probe.available}). ` +
            `${probe.detail} ${probe.recoveryCommand}`,
          isError: true,
        }
      }
      const result = await runComputerUseLoop({
        objective: input.objective,
        targetSurface: input.targetSurface ?? 'browser',
        allowFullDesktop: input.allowFullDesktop ?? false,
        maxSteps: input.maxSteps ?? 12,
        maxTotalTokens: input.maxTotalTokens ?? 100_000,
        client: options.client,
        backend: options.backend,
        signal: ctx.abortSignal,
      })
      return {
        output: JSON.stringify(result, null, 2),
        isError: result.status !== 'completed',
      }
    },
  }
}
