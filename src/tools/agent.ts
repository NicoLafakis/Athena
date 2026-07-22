import { z } from 'zod'
import type { ToolDefinition } from '../engine/types.js'
import type { AgentOrchestrator } from '../harness/agents.js'

const AgentInput = z.object({
  agent: z.string(),
  prompt: z.string().min(1),
})

export function makeAgentTool(
  orchestrator: AgentOrchestrator,
): ToolDefinition<z.infer<typeof AgentInput>> {
  return {
    name: 'Agent',
    description:
      'Spawn a sub-agent by name with a task prompt. The sub-agent runs its own loop with a restricted tool set and returns its final report. Available agents: ' +
      orchestrator
        .listDefs()
        .map((d) => `${d.name} (${d.description})`)
        .join('; '),
    schema: AgentInput,
    readOnly: false,
    async execute(input, ctx) {
      const def = orchestrator.getDef(input.agent)
      if (!def) {
        return {
          output: `Unknown agent "${input.agent}". Available: ${
            orchestrator
              .listDefs()
              .map((d) => d.name)
              .join(', ') || '(none defined)'
          }`,
          isError: true,
        }
      }
      return orchestrator.runAgent(def, input.prompt, ctx)
    },
  }
}
