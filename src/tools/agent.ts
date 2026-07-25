import { z } from 'zod'
import type { ToolDefinition } from '../engine/types.js'
import type { AgentOrchestrator } from '../harness/agents.js'

const AgentInput = z.object({
  action: z.enum(['run', 'followup', 'resume', 'status', 'list']).optional(),
  agent: z.string().optional(),
  prompt: z.string().min(1).optional(),
  run_id: z.string().optional(),
})

export function makeAgentTool(
  orchestrator: AgentOrchestrator,
): ToolDefinition<z.infer<typeof AgentInput>> {
  const withRunId = async (
    result: ReturnType<AgentOrchestrator['runAgent']>,
  ): Promise<Awaited<typeof result>> => {
    const output = await result
    return output.runId
      ? { ...output, output: `run_id: ${output.runId}\n\n${output.output}` }
      : output
  }

  return {
    name: 'Agent',
    description:
      'Run and manage durable sub-agents. action=run needs agent+prompt; followup/resume needs run_id+prompt; status needs run_id; list has no other fields. Completed runs return a run_id for later follow-up. Available agents: ' +
      orchestrator
        .listDefs()
        .map((definition) => `${definition.name} (${definition.description})`)
        .join('; '),
    schema: AgentInput,
    readOnly: false,
    concurrencySafe(input) {
      const value = (input ?? {}) as z.infer<typeof AgentInput>
      if ((value.action ?? 'run') !== 'run' || !value.agent) return false
      const def = orchestrator.getDef(value.agent)
      return def ? orchestrator.isConcurrencySafe(def) : false
    },
    async execute(input, ctx) {
      if (input.action === 'list') return orchestrator.listRuns()
      if (input.action === 'status') {
        return input.run_id
          ? orchestrator.status(input.run_id)
          : { output: 'Agent status requires run_id', isError: true }
      }
      if (input.action === 'followup' || input.action === 'resume') {
        return input.run_id && input.prompt
          ? withRunId(orchestrator.followUp(input.run_id, input.prompt, ctx))
          : { output: `Agent ${input.action} requires run_id and prompt`, isError: true }
      }
      if (!input.agent || !input.prompt) {
        return { output: 'Agent run requires agent and prompt', isError: true }
      }
      const def = orchestrator.getDef(input.agent)
      if (!def) {
        return {
          output: `Unknown agent "${input.agent}". Available: ${
            orchestrator
              .listDefs()
              .map((definition) => definition.name)
              .join(', ') || '(none defined)'
          }`,
          isError: true,
        }
      }
      return withRunId(orchestrator.runAgent(def, input.prompt, ctx))
    },
  }
}
