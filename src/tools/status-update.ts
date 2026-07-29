import { z } from 'zod'
import type { ToolDefinition } from '../engine/types.js'

const StatusUpdateInput = z.object({
  objective: z.string().min(1).max(4_096).optional(),
  nextExpected: z.string().min(1).max(1_024).optional(),
}).strict().refine(
  (value) => value.objective !== undefined || value.nextExpected !== undefined,
  { message: 'Provide objective or nextExpected.' },
)

export const statusUpdateTool: ToolDefinition<z.infer<typeof StatusUpdateInput>> = {
  name: 'StatusUpdate',
  description:
    'Record a concise current objective or next expected step. This is an agent assertion, not proof that work succeeded.',
  schema: StatusUpdateInput,
  readOnly: true,
  async execute(input, ctx) {
    ctx.emit({
      type: 'agent-status-update',
      ...(input.objective !== undefined ? { objective: input.objective } : {}),
      ...(input.nextExpected !== undefined ? { nextExpected: input.nextExpected } : {}),
      sourceRef: ctx.toolCallId ?? 'StatusUpdate',
      ...(ctx.runId ? { runId: ctx.runId } : {}),
    })
    return { output: 'Status update recorded.', isError: false }
  },
}
