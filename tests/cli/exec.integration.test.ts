import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

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
  })

  it('reads a prompt from stdin and emits versioned JSONL events', () => {
    writeFileSync(script, JSON.stringify([{ text: 'from stdin' }]))
    const result = run(['exec', '--output', 'jsonl'], 'piped prompt')
    expect(result.status, result.stderr).toBe(0)
    const lines = result.stdout.trim().split('\n').map((line) => JSON.parse(line))
    expect(lines.every((line) => line.schemaVersion === 1)).toBe(true)
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
})
