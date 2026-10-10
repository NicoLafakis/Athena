import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HarnessSessionController } from '../../src/harness/controller.js'
import { resolveBrainPaths } from '../../src/brain/paths.js'
import { SettingsSchema } from '../../src/brain/settings.js'
import { MockAnthropicClient, textBlock, toolUseBlock } from '../helpers/mock-client.js'
import { readRunTrace, verifyRunTrace } from '../../src/harness/traces.js'
import { AgentOrchestrator } from '../../src/harness/agents.js'
import { HookRunner } from '../../src/harness/hooks.js'
import { ToolRegistry } from '../../src/tools/registry.js'
import { makeInvestigationTool } from '../../src/tools/investigation.js'
import type { ToolDefinition } from '../../src/engine/types.js'
import type { ModelClient } from '../../src/engine/client.js'
import type { AgentDef } from '../../src/brain/loader.js'
import type { InvestigationReport } from '../../src/investigation/types.js'
import { makeCtx } from '../helpers/tool-ctx.js'

let root: string
let home: string
let base: string
const settings = SettingsSchema.parse({})
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'athena-investigation-engine-'))
  root = join(base, 'project')
  home = join(base, 'home')
  mkdirSync(root)
  mkdirSync(home)
  writeFileSync(join(root, 'feature.ts'), 'export const result = 20\n')
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('investigation execution in the shared harness', () => {
  it('completes a bounded source trace through real registered tool dispatch and retains the result', async () => {
    let stage = 0
    let report: InvestigationReport | null = null
    const client: ModelClient = {
      async stream(params, callbacks) {
        const content = params.messages.at(-1)?.content
        if (Array.isArray(content)) {
          const result = content.find(block => block.type === 'tool_result')
          if (result && typeof result.content === 'string') report = JSON.parse(result.content) as InvestigationReport
        }
        const id = report?.id
        const evidence = report?.observations[0]?.id
        const operations = [
          { op: 'start', question: 'Trace the declared result literal', files: ['feature.ts'] },
          { op: 'read', id, file_path: 'feature.ts', offset: 1, limit: 1 },
          { op: 'submit', id, expectedVersion: report?.version, result: {
            hypotheses: [
              { id: 'twenty', statement: 'Source declares 20', supports: [evidence], counterevidence: [] },
              { id: 'ten', statement: 'Source declares 10', supports: [], counterevidence: [evidence] },
            ],
            claims: [{ id: 'literal', statement: 'Selected text contains result = 20', scope: 'source-text', evidenceIds: [evidence], counterevidenceIds: [], testIds: ['twenty'] }],
            tests: [
              { id: 'twenty', hypothesisId: 'twenty', provider: 'source-text', observationId: evidence, contains: 'result = 20', expect: 'present' },
              { id: 'ten', hypothesisId: 'ten', provider: 'source-text', observationId: evidence, contains: 'result = 10', expect: 'present' },
            ], unknowns: [],
          } },
          { op: 'complete', id },
        ]
        const input = operations[stage++]
        return new MockAnthropicClient([input
          ? { blocks: [toolUseBlock(`call-${stage}`, 'Investigation', input)], stopReason: 'tool_use' }
          : { blocks: [textBlock('The literal source predicate passed within its recorded scope.')], stopReason: 'end_turn' },
        ]).stream(params, callbacks)
      },
      complete: async () => 'unused',
    }
    const paths = resolveBrainPaths({ cwd: root, homeOverride: home })
    const controller = await HarnessSessionController.create({
      paths, effectivePaths: paths, cwd: root, provider: 'anthropic', client,
      settings: { ...settings, permissionMode: 'trusted' },
      projectTrust: { trusted: true, allowProjectHooks: false, allowProjectMcp: false },
    })
    try {
      expect((await controller.submitTurn('Trace')).status).toBe('completed')
      const retained = report as InvestigationReport | null
      expect(retained?.verification.complete).toBe(true)
      expect(readFileSync(retained!.ledgerFile, 'utf8')).toContain('twenty')
    } finally { await controller.close() }
  })

  it('registers the real tool and makes an unverified investigation fail end_turn with trace evidence', async () => {
    const paths = resolveBrainPaths({ cwd: root, homeOverride: home })
    const client = new MockAnthropicClient([
      { blocks: [toolUseBlock('start', 'Investigation', { op: 'start', question: 'Investigate this feature', files: ['feature.ts'] })], stopReason: 'tool_use' },
      { blocks: [textBlock('Everything is verified.')], stopReason: 'end_turn' },
      { blocks: [textBlock('A separate ordinary turn.')], stopReason: 'end_turn' },
    ])
    const controller = await HarnessSessionController.create({
      paths, effectivePaths: paths, cwd: root, provider: 'anthropic', client,
      settings: { ...settings, permissionMode: 'trusted' },
      projectTrust: { trusted: true, allowProjectHooks: false, allowProjectMcp: false },
    })
    try {
      const first = await controller.submitTurn('Investigate')
      expect(first.status).toBe('failed')
      expect(first.summary).toContain('not verified')
      const second = await controller.submitTurn('Ordinary turn')
      expect(second.status).toBe('completed')
    } finally { await controller.close() }
    const trace = await readRunTrace(controller.trace.file)
    expect(trace.some(e => e.type === 'engine-event' && JSON.stringify(e.payload).includes('not verified'))).toBe(true)
    expect((await verifyRunTrace(controller.trace.file)).valid).toBe(true)
  })

  it('keeps a denied investigation fail-closed without creating an active completion claim', async () => {
    const paths = resolveBrainPaths({ cwd: root, homeOverride: home })
    const client = new MockAnthropicClient([
      { blocks: [toolUseBlock('start', 'Investigation', { op: 'start', question: 'Investigate', files: ['feature.ts'] })], stopReason: 'tool_use' },
      { blocks: [textBlock('Permission was denied.')], stopReason: 'end_turn' },
    ])
    const controller = await HarnessSessionController.create({
      paths, effectivePaths: paths, cwd: root, provider: 'anthropic', client,
      settings,
      projectTrust: { trusted: false, allowProjectHooks: false, allowProjectMcp: false },
    })
    try {
      expect((await controller.submitTurn('Investigate')).status).toBe('completed')
      expect(JSON.stringify(client.calls.at(-1))).toContain('Permission denied')
    } finally { await controller.close() }
  })

  it('accepts source inside a project opened through a canonical filesystem alias', async () => {
    const alias = join(base, 'project-alias')
    symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const paths = resolveBrainPaths({ cwd: alias, homeOverride: home })
    const client = new MockAnthropicClient([
      { blocks: [toolUseBlock('start', 'Investigation', { op: 'start', question: 'Inspect aliased project', files: ['feature.ts'] })], stopReason: 'tool_use' },
      { blocks: [textBlock('Still needs a result.')], stopReason: 'end_turn' },
    ])
    const controller = await HarnessSessionController.create({
      paths, effectivePaths: paths, cwd: alias, provider: 'anthropic', client,
      settings: { ...settings, permissionMode: 'trusted' },
      projectTrust: { trusted: true, allowProjectHooks: false, allowProjectMcp: false },
    })
    try {
      await controller.submitTurn('Investigate')
      expect(JSON.stringify(client.calls.at(-1))).not.toContain('outside the investigation project')
      expect(JSON.stringify(client.calls.at(-1))).toContain('feature.ts')
      expect(JSON.stringify(client.calls.at(-1))).toContain('schemaVersion')
    } finally { await controller.close() }
  })

  it('propagates an unverified durable child as a failed Agent result instead of successful prose', async () => {
    const registry = new ToolRegistry()
    const investigation = makeInvestigationTool()
    registry.register(investigation as ToolDefinition<never>)
    const definition: AgentDef = { name: 'investigator', description: 'Investigate source', tools: ['Investigation'], model: null, systemPrompt: 'Investigate the question.', file: 'fixture' }
    const orchestrator = new AgentOrchestrator({
      defs: [definition], baseRegistry: registry,
      clientFactory: () => new MockAnthropicClient([
        { blocks: [toolUseBlock('start', 'Investigation', { op: 'start', question: 'Investigate', files: ['feature.ts'] })], stopReason: 'tool_use' },
        { blocks: [textBlock('Verified everything.')], stopReason: 'end_turn' },
      ]),
      gate: { check: () => ({ decision: 'allow', reason: 'test' }), grantSession: () => {} },
      hooks: new HookRunner([]), defaultModel: () => 'sonnet', defaultEffort: () => 'high', systemPromptBase: 'test',
      runStoreDir: join(root, 'children'), traceRootDir: join(root, 'traces'),
    })
    const context = makeCtx(root, { runId: 'parent', brainDir: join(root, '.brain') })
    const result = await orchestrator.runAgent(definition, 'Investigate', context)
    expect(result.isError).toBe(true)
    expect(result.output).toContain('not verified')
    expect(JSON.parse(readFileSync(join(root, 'children', `${result.runId}.json`), 'utf8')).status).toBe('failed')
    expect(await investigation.completionCheck!(context)).toBe(null)
  })
})
