import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import {
  ExperienceRecordSchema,
  ExperienceStore,
  GuidanceRecordSchema,
} from '../../src/experience/index.js'
import { ContinuityStore } from '../../src/continuity/store.js'
import { SessionStore } from '../../src/harness/sessions.js'
import { projectId } from '../../src/harness/trust.js'

let root: string
let home: string
let project: string
let script: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'athena-exec-'))
  home = join(root, 'home')
  project = join(root, 'project')
  script = join(root, 'script.json')
  mkdirSync(home)
  mkdirSync(project)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function run(args: string[], stdin?: string) {
  const repository = process.cwd()
  const tsx = join(repository, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const cli = join(repository, 'src', 'cli.ts')
  return spawnSync(process.execPath, [tsx, cli, ...args], {
    cwd: project,
    input: stdin,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      ATHENA_TEST_MODEL_SCRIPT: script,
      ANTHROPIC_API_KEY: 'fixture-key',
      HOME: home,
      USERPROFILE: home,
      PATH: `${join(repository, 'node_modules', '.bin')}${delimiter}${process.env['PATH'] ?? ''}`,
    },
  })
}

describe('athena exec process contract', () => {
  it('runs the append-only screen-reader composition without Ink control sequences', () => {
    writeFileSync(script, JSON.stringify([{ text: 'ordinary assistant output' }]))
    const result = run(['--accessibility', 'screen-reader'], 'do work\n/quit\n')
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Status: Athena screen-reader mode is ready.')
    expect(result.stdout).toContain('ordinary assistant output\n')
    expect(result.stdout.match(/ordinary assistant output/g)).toHaveLength(1)
    expect(result.stdout.match(/Completed: Work completed\./g)).toHaveLength(1)
    expect(result.stdout).toContain('You: ')
    expect(result.stdout).not.toMatch(/\u001b\[|\u001b\]|\u009b/)
  })

  it('answers accessible permission prompts with stable detail routes and diff counts', () => {
    writeFileSync(script, JSON.stringify([
      {
        toolUses: [{
          id: 'write-accessible',
          name: 'Write',
          input: { file_path: 'x.txt', content: 'secret-content-must-not-be-announced' },
        }],
        stopReason: 'tool_use',
      },
      { text: 'write complete' },
    ]))
    const result = run(['--accessibility', 'screen-reader'], 'write x\ny\n/quit\n')
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Permission: Write requires a decision.')
    expect(result.stdout.match(/Permission: Write requires a decision\./g)).toHaveLength(1)
    expect(result.stdout).toContain('Target: x.txt')
    expect(result.stdout).toContain('Changes: 1 added line, 0 removed lines.')
    expect(result.stdout).toContain('/details permission permission:write-accessible')
    expect(result.stdout).not.toContain('secret-content-must-not-be-announced')
  })

  it('serves local status without spending a fixture-model call', () => {
    writeFileSync(script, '[]')
    const result = run(['--accessibility', 'screen-reader'], '/status\n/quit\n')
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Status: no semantic state is available for this run.')
    expect(result.stderr).not.toContain('Fixture model script exhausted')
  })

  it('runs the standalone memory rank command locally without returning source text', () => {
    writeFileSync(script, '[]')
    const sessionsRoot = join(home, '.athena', 'sessions')
    const session = new SessionStore(sessionsRoot, project).create()
    session.appendMessage({ role: 'user', content: 'We decided to keep continuity memories linked to their context.' })
    session.appendMessage({ role: 'assistant', content: 'The source session remains available for inspection.' })
    session.appendEvent({ type: 'turn-done' })
    const continuityStore = new ContinuityStore(join(home, '.athena', 'continuity'))
    continuityStore.rebuild(sessionsRoot)
    const [episode] = continuityStore.listEpisodes()
    expect(episode).toBeDefined()

    const result = run(['memory', 'rank', 'what', 'did', 'we', 'decide', 'about', 'continuity'])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Local recall ranking (intent: decision')
    expect(result.stdout).toContain(`episodic ${episode!.id}`)
    expect(result.stdout).not.toContain('We decided to keep continuity memories')
    expect(result.stderr).not.toContain('Fixture model script exhausted')
  })

  it('runs from an argument and emits one stable JSON envelope', () => {
    writeFileSync(script, JSON.stringify([{ text: 'done' }]))
    const result = run(['exec', 'do work', '--output', 'json'])
    expect(result.status, result.stderr).toBe(0)
    const output = JSON.parse(result.stdout) as Record<string, unknown>
    expect(output).toMatchObject({
      schemaVersion: 1,
      status: 'completed',
      exitCode: 0,
      output: 'done',
      sessionId: null,
    })
    expect(output['runId']).toEqual(expect.any(String))
    expect(output['traceFile']).toEqual(expect.any(String))

    const traceLines = readFileSync(output['traceFile'] as string, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; payload: unknown })
    const semantic = traceLines.filter((line) => line.type === 'interaction-event')
    expect(semantic.map((line) => (line.payload as { kind: string }).kind)).toEqual([
      'objective-set',
      'phase-changed',
      'phase-changed',
      'outcome-recorded',
    ])
  })

  it('reads a prompt from stdin and emits versioned JSONL events', () => {
    writeFileSync(script, JSON.stringify([{ text: 'from stdin' }]))
    const result = run(
      ['exec', '--output', 'jsonl'],
      'piped prompt with sk-ant-api03-supersecretvalue1234',
    )
    expect(result.status, result.stderr).toBe(0)
    const lines = result.stdout.trim().split('\n').map((line) => JSON.parse(line))
    expect(lines.every((line) => line.schemaVersion === 1)).toBe(true)
    expect(result.stdout).not.toContain('supersecretvalue1234')
    const semantic = lines.filter((line) => line.event.type === 'interaction-event')
    expect(semantic.map((line) => line.event.envelope.kind)).toEqual([
      'objective-set',
      'phase-changed',
      'phase-changed',
      'outcome-recorded',
    ])
    const turnStart = lines.findIndex((line) => line.event.type === 'turn-start')
    const thinking = lines.findIndex((line) =>
      line.event.type === 'interaction-event' &&
      line.event.envelope.kind === 'phase-changed' &&
      line.event.envelope.payload.phase === 'thinking',
    )
    expect(turnStart).toBeLessThan(thinking)
    expect(lines.at(-1).event).toMatchObject({ type: 'exec-result', output: 'from stdin' })
  })

  it('returns the documented permission exit code for an unapproved mutation', () => {
    writeFileSync(
      script,
      JSON.stringify([
        {
          toolUses: [{ id: 'write-1', name: 'Write', input: { file_path: 'x.txt', content: 'x' } }],
          stopReason: 'tool_use',
        },
        { text: 'could not write' },
      ]),
    )
    const result = run(['exec', 'write x', '--output', 'json'])
    expect(result.status).toBe(3)
    expect(JSON.parse(result.stdout)).toMatchObject({ exitCode: 3 })
  })

  it('validates final JSON against an output schema', () => {
    const schema = join(root, 'schema.json')
    writeFileSync(schema, JSON.stringify({
      type: 'object',
      required: ['answer'],
      properties: { answer: { type: 'string' } },
      additionalProperties: false,
    }))
    writeFileSync(script, JSON.stringify([{ text: '{"answer":"yes"}' }]))
    const result = run(['exec', 'answer', '--output', 'json', '--output-schema', schema])
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ outputValue: { answer: 'yes' } })
  })

  it('qualifies reviewed project guidance after a repeated unchanged failure', () => {
    const experienceStore = new ExperienceStore(join(home, '.athena', 'experience'))
    experienceStore.appendExperience(ExperienceRecordSchema.parse({
      schemaVersion: 1,
      id: 'exp-read-failure',
      projectScope: projectId(project),
      situation: 'Inspect a missing file safely.',
      actions: ['Read failed.'],
      outcome: 'failed',
      evidenceRefs: ['trace:prior:hash'],
      tags: ['read', 'failed'],
      createdAt: '2026-07-29T12:00:00.000Z',
    }))
    experienceStore.appendGuidance(GuidanceRecordSchema.parse({
      schemaVersion: 1,
      id: 'guide-read-failure',
      experienceIds: ['exp-read-failure'],
      signal: 'avoid',
      text: 'Sensitive stored guidance must not cross the semantic event seam.',
      status: 'active',
      confidence: 0.9,
      reviewedAt: new Date().toISOString(),
    }))
    const missing = join(project, 'missing.txt')
    writeFileSync(script, JSON.stringify([
      { toolUses: [{ id: 'read-1', name: 'Read', input: { file_path: missing } }], stopReason: 'tool_use' },
      { toolUses: [{ id: 'read-2', name: 'Read', input: { file_path: missing } }], stopReason: 'tool_use' },
      { text: 'done' },
    ]))

    const result = run(['exec', 'Inspect a missing file safely.', '--output', 'jsonl'])
    expect(result.status, result.stderr).toBe(0)
    const lines = result.stdout.trim().split('\n').map((line) => JSON.parse(line))
    const qualified = lines.find(
      (line) => line.event.type === 'interaction-event'
        && line.event.envelope.kind === 'guidance-qualified',
    )
    expect(qualified?.event.envelope.payload).toEqual({
      guidanceId: 'guide-read-failure',
      experienceIds: ['exp-read-failure'],
      signal: 'avoid',
      confidence: 0.9,
    })
    expect(result.stdout).not.toContain('Sensitive stored guidance')
  })
})
