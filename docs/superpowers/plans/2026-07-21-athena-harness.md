# Athena Coding Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Athena v1: a standalone TypeScript terminal coding agent (own agentic loop on @anthropic-ai/sdk, Ink TUI, permission engine, hooks, sub-agents, brain directory).

**Architecture:** Four strictly-layered subsystems — Engine (loop + tools, emits typed events, never touches the terminal), Harness (permissions, hooks, sub-agents, sessions), TUI (Ink), Brain (~/.athena data). Spec: docs/superpowers/specs/2026-07-21-athena-harness-design.md

**Tech Stack:** TypeScript strict, Node >= 20, pnpm, @anthropic-ai/sdk, ink + react, @vscode/ripgrep, zod, vitest, tsup.

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `tsup.config.ts`, `eslint.config.js`, `bin/athena.js`, `.gitignore`, `src/cli.ts`, `src/engine/index.ts`, `src/harness/index.ts`, `src/tui/index.ts`, `src/brain/index.ts`, `src/tools/index.ts`

**Steps:**

- [ ] Write `package.json`:

```json
{
  "name": "athena",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": { "athena": "bin/athena.js" },
  "engines": { "node": ">=20" },
  "scripts": {
    "dev": "tsx src/cli.ts",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src tests",
    "test": "vitest run",
    "build": "tsup"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.57.0",
    "@vscode/ripgrep": "^1.15.9",
    "ink": "^5.2.0",
    "react": "^18.3.1",
    "tinyglobby": "^0.2.10",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "@types/react": "^18.3.12",
    "eslint": "^9.17.0",
    "ink-testing-library": "^4.0.0",
    "tsup": "^8.3.5",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2",
    "typescript-eslint": "^8.18.0",
    "vitest": "^2.1.8"
  }
}
```

- [ ] Write `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"],
    "lib": ["ES2022"]
  },
  "include": ["src", "tests"]
}
```

- [ ] Write `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environment: 'node',
    testTimeout: 20_000,
  },
})
```

- [ ] Write `tsup.config.ts`:

```ts
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  sourcemap: true,
})
```

- [ ] Write `eslint.config.js`:

```js
import tseslint from 'typescript-eslint'

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  { ignores: ['dist/**', 'bin/**', 'node_modules/**'] },
)
```

- [ ] Write `bin/athena.js`:

```js
#!/usr/bin/env node
import '../dist/cli.js'
```

- [ ] Write `.gitignore`:

```
node_modules/
dist/
*.log
.env
.env.*
```

- [ ] Write `src/cli.ts` (temporary stub, replaced in Task 15):

```ts
console.log('athena v0.1.0 — engine not wired yet')
```

- [ ] Write identical one-line stubs `src/engine/index.ts`, `src/harness/index.ts`, `src/tui/index.ts`, `src/brain/index.ts`, `src/tools/index.ts`:

```ts
export {}
```

- [ ] Run `pnpm install`, then `pnpm typecheck && pnpm build`. Expect: both exit 0, `dist/cli.js` produced. Run `node bin/athena.js` — expect the stub line printed.
- [ ] Commit:

```
git add package.json tsconfig.json vitest.config.ts tsup.config.ts eslint.config.js bin/athena.js .gitignore src/cli.ts src/engine/index.ts src/harness/index.ts src/tui/index.ts src/brain/index.ts src/tools/index.ts pnpm-lock.yaml
git commit -m "chore: scaffold Athena package (pnpm, strict TS, vitest, tsup, eslint, bin shim)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 2: Core type contracts + event bus

**Files:**
- Create: `src/engine/types.ts`, `src/engine/events.ts`
- Modify: `src/engine/index.ts`
- Test: `tests/engine/events.test.ts`

**Steps:**

- [ ] Write failing test `tests/engine/events.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { EngineEventBus } from '../../src/engine/events.js'
import type { EngineEvent } from '../../src/engine/types.js'

describe('EngineEventBus', () => {
  it('delivers events to all listeners in subscription order', () => {
    const bus = new EngineEventBus()
    const seen: string[] = []
    bus.on((e) => seen.push(`a:${e.type}`))
    bus.on((e) => seen.push(`b:${e.type}`))
    const event: EngineEvent = { type: 'assistant-text', delta: 'hi' }
    bus.emit(event)
    expect(seen).toEqual(['a:assistant-text', 'b:assistant-text'])
  })

  it('unsubscribe stops delivery', () => {
    const bus = new EngineEventBus()
    const seen: EngineEvent[] = []
    const off = bus.on((e) => seen.push(e))
    off()
    bus.emit({ type: 'error', message: 'x', fatal: false })
    expect(seen).toHaveLength(0)
  })

  it('a listener added during emit does not receive the in-flight event', () => {
    const bus = new EngineEventBus()
    let lateCalls = 0
    bus.on(() => {
      bus.on(() => { lateCalls += 1 })
    })
    bus.emit({ type: 'assistant-text', delta: 'x' })
    expect(lateCalls).toBe(0)
  })
})
```

- [ ] Run `pnpm test tests/engine/events.test.ts` — expect failure: cannot resolve `../../src/engine/events.js`.
- [ ] Write `src/engine/types.ts` with EXACTLY this content:

```ts
// src/engine/types.ts
import type { z } from 'zod'

export interface TokenUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number }

export type EngineEvent =
  | { type: 'assistant-text'; delta: string }
  | { type: 'assistant-thinking'; delta: string }
  | { type: 'tool-request'; id: string; name: string; input: unknown }
  | { type: 'tool-result'; id: string; name: string; output: string; isError: boolean }
  | { type: 'todo-update'; todos: TodoItem[] }
  | { type: 'turn-done'; usage: TokenUsage }
  | { type: 'compaction'; summary: string }
  | { type: 'error'; message: string; fatal: boolean }

export interface TodoItem { text: string; status: 'pending' | 'in_progress' | 'done' }

export interface ToolOutput { output: string; isError: boolean }

export interface ToolContext {
  cwd: string
  brainDir: string
  projectBrainDir: string | null
  fileReadRegistry: Set<string>
  todos: TodoItem[]
  emit: (event: EngineEvent) => void
  abortSignal: AbortSignal
}

export interface ToolDefinition<I = unknown> {
  name: string
  description: string
  schema: z.ZodType<I>
  readOnly: boolean
  execute(input: I, ctx: ToolContext): Promise<ToolOutput>
}

export type PermissionMode = 'normal' | 'acceptEdits' | 'plan' | 'trusted'

export interface PermissionRequest { toolName: string; input: unknown; readOnly: boolean; summary: string }

export type PermissionDecision =
  | { decision: 'allow'; reason: string }
  | { decision: 'deny'; reason: string }
  | { decision: 'ask'; reason: string }

export interface PermissionGate {
  check(req: PermissionRequest): PermissionDecision
  grantSession(rule: string): void
}

export type HookEventName = 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'Stop'

export interface HookOutcome { allowed: boolean; reason?: string; addedContext?: string }
```

- [ ] Write `src/engine/events.ts`:

```ts
// src/engine/events.ts
import type { EngineEvent } from './types.js'

export type EngineEventListener = (event: EngineEvent) => void

export class EngineEventBus {
  private listeners = new Set<EngineEventListener>()

  on(listener: EngineEventListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  emit(event: EngineEvent): void {
    // Snapshot so listeners added mid-emit do not receive the in-flight event.
    for (const listener of [...this.listeners]) listener(event)
  }
}
```

- [ ] Replace `src/engine/index.ts` stub with re-exports:

```ts
export * from './types.js'
export * from './events.js'
```

- [ ] Run `pnpm test tests/engine/events.test.ts` — expect 3 passing. Run `pnpm typecheck` — expect exit 0.
- [ ] Commit:

```
git add src/engine/types.ts src/engine/events.ts src/engine/index.ts tests/engine/events.test.ts
git commit -m "feat(engine): canonical type contracts and typed event bus

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 3: Brain layer (paths, settings, loader)

**Files:**
- Create: `src/brain/paths.ts`, `src/brain/settings.ts`, `src/brain/loader.ts`
- Modify: `src/brain/index.ts` (re-export the three modules)
- Test: `tests/brain/paths.test.ts`, `tests/brain/settings.test.ts`, `tests/brain/loader.test.ts`

**Steps:**

- [ ] Write failing test `tests/brain/settings.test.ts` (temp-dir pattern reused by every brain test):

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveBrainPaths } from '../../src/brain/paths.js'
import { loadSettings, SettingsSchema } from '../../src/brain/settings.js'

let home: string
let project: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'athena-home-'))
  project = mkdtempSync(join(tmpdir(), 'athena-proj-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
})

describe('loadSettings', () => {
  it('returns schema defaults when no settings.json exists', () => {
    const paths = resolveBrainPaths({ cwd: project, homeOverride: home })
    const s = loadSettings(paths)
    expect(s.model).toBe(SettingsSchema.parse({}).model)
    expect(s.permissionMode).toBe('normal')
    expect(s.allow).toEqual([])
  })

  it('project settings override global scalars and concatenate rule arrays', () => {
    mkdirSync(join(home, '.athena'), { recursive: true })
    writeFileSync(join(home, '.athena', 'settings.json'),
      JSON.stringify({ model: 'global-model', allow: ['Read(**)'] }))
    mkdirSync(join(project, '.athena'), { recursive: true })
    writeFileSync(join(project, '.athena', 'settings.json'),
      JSON.stringify({ model: 'project-model', allow: ['Bash(git:*)'] }))
    const s = loadSettings(resolveBrainPaths({ cwd: project, homeOverride: home }))
    expect(s.model).toBe('project-model')
    expect(s.allow).toEqual(['Read(**)', 'Bash(git:*)'])
  })

  it('throws a readable error on invalid settings', () => {
    mkdirSync(join(home, '.athena'), { recursive: true })
    writeFileSync(join(home, '.athena', 'settings.json'), JSON.stringify({ permissionMode: 'yolo' }))
    expect(() => loadSettings(resolveBrainPaths({ cwd: project, homeOverride: home })))
      .toThrow(/permissionMode/)
  })
})
```

- [ ] Write failing test `tests/brain/loader.test.ts` (same temp-dir setup; abridged to the load-bearing cases):

```ts
it('loads skills index from SKILL.md frontmatter (both skills/<name>/SKILL.md and skills/<name>.md)', () => {
  const skills = join(home, '.athena', 'skills')
  mkdirSync(join(skills, 'coding-sop'), { recursive: true })
  writeFileSync(join(skills, 'coding-sop', 'SKILL.md'),
    '---\nname: coding-sop\ndescription: Pre-commit SOP\n---\n# Body\n')
  writeFileSync(join(skills, 'quick.md'), '---\nname: quick\ndescription: One-file skill\n---\nbody')
  const idx = loadSkillsIndex(resolveBrainPaths({ cwd: project, homeOverride: home }))
  expect(idx.map((s) => s.name).sort()).toEqual(['coding-sop', 'quick'])
  expect(idx.find((s) => s.name === 'coding-sop')!.description).toBe('Pre-commit SOP')
})

it('loads agents index with tools list and model from frontmatter', () => {
  const agents = join(home, '.athena', 'agents')
  mkdirSync(agents, { recursive: true })
  writeFileSync(join(agents, 'researcher.md'),
    '---\nname: researcher\ndescription: Read-only researcher\ntools: Read, Glob, Grep\nmodel: claude-haiku-4-5\n---\nYou research.\n')
  const idx = loadAgentsIndex(resolveBrainPaths({ cwd: project, homeOverride: home }))
  expect(idx[0]).toMatchObject({
    name: 'researcher',
    tools: ['Read', 'Glob', 'Grep'],
    model: 'claude-haiku-4-5',
  })
  expect(idx[0]!.systemPrompt).toContain('You research.')
})

it('project .athena/agents overrides a global agent of the same name', () => { /* same shape: write both, expect project description wins */ })
it('loadConstitution and loadMemoryIndex return null when files are absent', () => { /* expect null, no throw */ })
```

- [ ] Run `pnpm test tests/brain` — expect module-resolution failures.
- [ ] Write `src/brain/paths.ts` (full):

```ts
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

export interface BrainPaths {
  brainDir: string
  constitutionFile: string
  settingsFile: string
  memoryDir: string
  memoryIndexFile: string
  skillsDir: string
  agentsDir: string
  hooksDir: string
  sessionsDir: string
  journalDir: string
  projectBrainDir: string | null   // <cwd>/.athena when present
}

export function resolveBrainPaths(opts: { cwd: string; homeOverride?: string }): BrainPaths {
  const brainDir = join(opts.homeOverride ?? homedir(), '.athena')
  const projectBrain = join(opts.cwd, '.athena')
  return {
    brainDir,
    constitutionFile: join(brainDir, 'ATHENA.md'),
    settingsFile: join(brainDir, 'settings.json'),
    memoryDir: join(brainDir, 'memory'),
    memoryIndexFile: join(brainDir, 'memory', 'MEMORY.md'),
    skillsDir: join(brainDir, 'skills'),
    agentsDir: join(brainDir, 'agents'),
    hooksDir: join(brainDir, 'hooks'),
    sessionsDir: join(brainDir, 'sessions'),
    journalDir: join(brainDir, 'journal'),
    projectBrainDir: existsSync(projectBrain) ? projectBrain : null,
  }
}
```

- [ ] Write `src/brain/settings.ts` (full):

```ts
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { BrainPaths } from './paths.js'

export const HookDefSchema = z.object({
  event: z.enum(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']),
  matcher: z.string().optional(),          // tool-name matcher for Pre/PostToolUse, e.g. "Bash" or "*"
  command: z.string(),                     // executable + args, run via the system shell
  timeoutMs: z.number().int().positive().max(600_000).default(60_000),
})
export type HookDef = z.infer<typeof HookDefSchema>

export const SettingsSchema = z.object({
  model: z.string().default('claude-sonnet-4-5'),
  permissionMode: z.enum(['normal', 'acceptEdits', 'plan', 'trusted']).default('normal'),
  allow: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([]),
  hooks: z.array(HookDefSchema).default([]),
})
export type Settings = z.infer<typeof SettingsSchema>

function readJsonIfExists(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch (err) {
    throw new Error(`Malformed JSON in ${file}: ${(err as Error).message}`)
  }
}

/** Cascade: global ~/.athena/settings.json <- project .athena/settings.json.
 *  Scalars: project wins. Rule/hook arrays: concatenated global-first. */
export function loadSettings(paths: BrainPaths): Settings {
  const global = readJsonIfExists(paths.settingsFile)
  const project = paths.projectBrainDir
    ? readJsonIfExists(join(paths.projectBrainDir, 'settings.json'))
    : {}
  const merged: Record<string, unknown> = { ...global, ...project }
  for (const key of ['allow', 'deny', 'hooks'] as const) {
    merged[key] = [...((global[key] as unknown[]) ?? []), ...((project[key] as unknown[]) ?? [])]
  }
  const result = SettingsSchema.safeParse(merged)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`Invalid settings (${paths.settingsFile}): ${issues}`)
  }
  return result.data
}
```

- [ ] Write `src/brain/loader.ts`. Full frontmatter parser plus loaders; skills/agents merge global + project overlay with project winning on name collision:

```ts
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { BrainPaths } from './paths.js'

export interface SkillIndexEntry { name: string; description: string; file: string }
export interface AgentDef {
  name: string
  description: string
  tools: string[] | null      // null = all tools (minus Agent, enforced in Task 12)
  model: string | null
  systemPrompt: string
  file: string
}

export function parseFrontmatter(src: string): { attrs: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src)
  if (!match) return { attrs: {}, body: src }
  const attrs: Record<string, string> = {}
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (kv) attrs[kv[1]!.toLowerCase()] = kv[2]!.trim()
  }
  return { attrs, body: src.slice(match[0].length) }
}

export function loadConstitution(paths: BrainPaths): string | null {
  return existsSync(paths.constitutionFile) ? readFileSync(paths.constitutionFile, 'utf8') : null
}

export function loadMemoryIndex(paths: BrainPaths): string | null {
  return existsSync(paths.memoryIndexFile) ? readFileSync(paths.memoryIndexFile, 'utf8') : null
}

function skillFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      const skillMd = join(full, 'SKILL.md')
      if (existsSync(skillMd)) out.push(skillMd)
    } else if (entry.endsWith('.md')) {
      out.push(full)
    }
  }
  return out
}

export function loadSkillsIndex(paths: BrainPaths): SkillIndexEntry[] {
  const byName = new Map<string, SkillIndexEntry>()
  const dirs = [paths.skillsDir]
  if (paths.projectBrainDir) dirs.push(join(paths.projectBrainDir, 'skills'))
  for (const dir of dirs) {
    for (const file of skillFilesIn(dir)) {
      const { attrs } = parseFrontmatter(readFileSync(file, 'utf8'))
      const name = attrs['name']
      if (!name) continue
      byName.set(name, { name, description: attrs['description'] ?? '', file })
    }
  }
  return [...byName.values()]
}

export function loadAgentsIndex(paths: BrainPaths): AgentDef[] {
  const byName = new Map<string, AgentDef>()
  const dirs = [paths.agentsDir]
  if (paths.projectBrainDir) dirs.push(join(paths.projectBrainDir, 'agents'))
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
      const file = join(dir, entry)
      const { attrs, body } = parseFrontmatter(readFileSync(file, 'utf8'))
      const name = attrs['name']
      if (!name) continue
      byName.set(name, {
        name,
        description: attrs['description'] ?? '',
        tools: attrs['tools'] ? attrs['tools'].split(',').map((t) => t.trim()).filter(Boolean) : null,
        model: attrs['model'] ?? null,
        systemPrompt: body.trim(),
        file,
      })
    }
  }
  return [...byName.values()]
}
```

- [ ] Run `pnpm test tests/brain` — expect all passing. `pnpm typecheck && pnpm lint`.
- [ ] Commit:

```
git add src/brain/paths.ts src/brain/settings.ts src/brain/loader.ts src/brain/index.ts tests/brain/paths.test.ts tests/brain/settings.test.ts tests/brain/loader.test.ts
git commit -m "feat(brain): path resolution, zod settings cascade, constitution/memory/skills/agents loaders

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 4: Filesystem tools (Read, Write, Edit, Glob, Grep)

**Files:**
- Create: `src/tools/read.ts`, `src/tools/write.ts`, `src/tools/edit.ts`, `src/tools/glob.ts`, `src/tools/grep.ts`, `src/tools/registry.ts`
- Modify: `src/tools/index.ts`
- Test: `tests/tools/read.test.ts`, `tests/tools/write.test.ts`, `tests/tools/edit.test.ts`, `tests/tools/glob.test.ts`, `tests/tools/grep.test.ts`, `tests/helpers/tool-ctx.ts`

**Steps:**

- [ ] Write shared helper `tests/helpers/tool-ctx.ts`:

```ts
import type { ToolContext, EngineEvent } from '../../src/engine/types.js'

export function makeCtx(cwd: string, overrides: Partial<ToolContext> = {}): ToolContext & { events: EngineEvent[] } {
  const events: EngineEvent[] = []
  return {
    cwd,
    brainDir: cwd,
    projectBrainDir: null,
    fileReadRegistry: new Set<string>(),
    todos: [],
    emit: (e) => events.push(e),
    abortSignal: new AbortController().signal,
    events,
    ...overrides,
  }
}
```

- [ ] Write failing tests. The load-bearing cases per tool (each in its own file, temp-dir per test as in Task 3):

```ts
// read.test.ts
it('numbers lines cat -n style and registers the file in fileReadRegistry', async () => {
  writeFileSync(join(dir, 'a.txt'), 'alpha\nbeta\n')
  const ctx = makeCtx(dir)
  const res = await readTool.execute({ file_path: join(dir, 'a.txt') }, ctx)
  expect(res.isError).toBe(false)
  expect(res.output).toBe('     1\talpha\n     2\tbeta')
  expect(ctx.fileReadRegistry.has(resolve(join(dir, 'a.txt')))).toBe(true)
})
it('applies offset and limit', async () => { /* 5-line file, offset 2 limit 2 -> lines 2-3 with original numbering */ })
it('defaults to 2000 lines and notes truncation', async () => { /* 2500-line file -> 2000 lines + trailing "(truncated: showing lines 1-2000 of 2500)" */ })
it('errors on missing file', async () => { /* isError true, message contains path */ })

// write.test.ts
it('creates a new file without prior Read', async () => { /* new path -> isError false, file exists */ })
it('refuses to overwrite an existing file not read this session', async () => {
  writeFileSync(join(dir, 'a.txt'), 'old')
  const res = await writeTool.execute({ file_path: join(dir, 'a.txt'), content: 'new' }, makeCtx(dir))
  expect(res.isError).toBe(true)
  expect(res.output).toMatch(/read/i)
  expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('old')
})
it('overwrites after a Read in the same session', async () => { /* Read then Write -> succeeds */ })

// edit.test.ts
it('replaces an exact unique match', async () => { /* one occurrence replaced */ })
it('errors when old_string is not found', async () => { /* isError, "not found" */ })
it('errors when old_string matches more than once without replace_all', async () => { /* isError, reports count */ })
it('replace_all replaces every occurrence and reports the count', async () => { /* 3 -> 3 replacements */ })
it('requires the file to have been Read this session', async () => { /* isError without registry entry */ })

// glob.test.ts
it('matches ** patterns relative to cwd, newest first, ignoring node_modules and .git', async () => { /* create nested files incl. node_modules decoy */ })
it('returns a no-matches message, not an error', async () => { /* isError false, "No files matched" */ })

// grep.test.ts
it('finds pattern with file:line via ripgrep', async () => { /* expect "a.txt:1:" prefix in output */ })
it('returns no-matches cleanly when rg exits 1', async () => { /* isError false */ })
it('caps output at 30000 chars with truncation notice', async () => { /* huge match corpus */ })
```

- [ ] Run `pnpm test tests/tools` — expect failures (modules missing).
- [ ] Write `src/tools/read.ts` (full):

```ts
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import type { ToolDefinition } from '../engine/types.js'

const ReadInput = z.object({
  file_path: z.string(),
  offset: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).optional(),
})
const DEFAULT_LIMIT = 2000

export const readTool: ToolDefinition<z.infer<typeof ReadInput>> = {
  name: 'Read',
  description: 'Read a file with cat -n style line numbers. Supports offset (1-based first line) and limit.',
  schema: ReadInput,
  readOnly: true,
  async execute(input, ctx) {
    const abs = resolve(ctx.cwd, input.file_path)
    if (!existsSync(abs)) return { output: `File not found: ${abs}`, isError: true }
    let text: string
    try {
      text = readFileSync(abs, 'utf8')
    } catch (err) {
      return { output: `Cannot read ${abs}: ${(err as Error).message}`, isError: true }
    }
    const allLines = text.split('\n')
    if (allLines.at(-1) === '') allLines.pop()   // trailing newline is not a line
    const offset = input.offset ?? 1
    const limit = input.limit ?? DEFAULT_LIMIT
    const slice = allLines.slice(offset - 1, offset - 1 + limit)
    const numbered = slice
      .map((line, i) => `${String(offset + i).padStart(6, ' ')}\t${line}`)
      .join('\n')
    ctx.fileReadRegistry.add(abs)
    const shown = slice.length
    const truncated = offset - 1 + shown < allLines.length
    const notice = truncated
      ? `\n(truncated: showing lines ${offset}-${offset + shown - 1} of ${allLines.length})`
      : ''
    return { output: numbered + notice, isError: false }
  },
}
```

- [ ] Write `src/tools/write.ts` (full):

```ts
import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { z } from 'zod'
import type { ToolDefinition } from '../engine/types.js'

const WriteInput = z.object({ file_path: z.string(), content: z.string() })

export const writeTool: ToolDefinition<z.infer<typeof WriteInput>> = {
  name: 'Write',
  description: 'Create or overwrite a file. Overwriting requires the file to have been Read this session.',
  schema: WriteInput,
  readOnly: false,
  async execute(input, ctx) {
    const abs = resolve(ctx.cwd, input.file_path)
    if (existsSync(abs) && !ctx.fileReadRegistry.has(abs)) {
      return { output: `Refusing to overwrite ${abs}: file exists and has not been Read this session. Read it first.`, isError: true }
    }
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, input.content, 'utf8')
    ctx.fileReadRegistry.add(abs)   // its current content is now known
    return { output: `Wrote ${input.content.length} chars to ${abs}`, isError: false }
  },
}
```

- [ ] Write `src/tools/edit.ts` (full — the uniqueness check is the load-bearing logic):

```ts
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import type { ToolDefinition } from '../engine/types.js'

const EditInput = z.object({
  file_path: z.string(),
  old_string: z.string().min(1),
  new_string: z.string(),
  replace_all: z.boolean().default(false),
})

export const editTool: ToolDefinition<z.infer<typeof EditInput>> = {
  name: 'Edit',
  description: 'Exact string replacement. old_string must match exactly once unless replace_all is true.',
  schema: EditInput,
  readOnly: false,
  async execute(input, ctx) {
    const abs = resolve(ctx.cwd, input.file_path)
    if (!existsSync(abs)) return { output: `File not found: ${abs}`, isError: true }
    if (!ctx.fileReadRegistry.has(abs)) {
      return { output: `Refusing to edit ${abs}: not Read this session. Read it first.`, isError: true }
    }
    if (input.old_string === input.new_string) {
      return { output: 'old_string and new_string are identical.', isError: true }
    }
    const text = readFileSync(abs, 'utf8')
    const count = text.split(input.old_string).length - 1
    if (count === 0) {
      return { output: `old_string not found in ${abs}. Match must be exact, including whitespace.`, isError: true }
    }
    if (count > 1 && !input.replace_all) {
      return { output: `old_string matches ${count} times in ${abs}. Provide a longer unique string or set replace_all: true.`, isError: true }
    }
    const next = input.replace_all
      ? text.split(input.old_string).join(input.new_string)
      : text.replace(input.old_string, input.new_string)
    writeFileSync(abs, next, 'utf8')
    return { output: `Replaced ${input.replace_all ? count : 1} occurrence(s) in ${abs}`, isError: false }
  },
}
```

- [ ] Write `src/tools/glob.ts` (full):

```ts
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { glob } from 'tinyglobby'
import { z } from 'zod'
import type { ToolDefinition } from '../engine/types.js'

const GlobInput = z.object({ pattern: z.string(), path: z.string().optional() })

export const globTool: ToolDefinition<z.infer<typeof GlobInput>> = {
  name: 'Glob',
  description: 'Fast file pattern matching, e.g. "src/**/*.ts". Results sorted newest-modified first.',
  schema: GlobInput,
  readOnly: true,
  async execute(input, ctx) {
    const base = resolve(ctx.cwd, input.path ?? '.')
    const matches = await glob(input.pattern, {
      cwd: base,
      dot: true,
      absolute: true,
      ignore: ['**/node_modules/**', '**/.git/**'],
    })
    if (matches.length === 0) return { output: `No files matched ${input.pattern} in ${base}`, isError: false }
    const sorted = matches
      .map((f) => ({ f, mtime: statSync(f).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .map((x) => x.f)
    return { output: sorted.join('\n'), isError: false }
  },
}
```

- [ ] Write `src/tools/grep.ts` (full — spawns the bundled ripgrep binary):

```ts
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { rgPath } from '@vscode/ripgrep'
import { z } from 'zod'
import type { ToolDefinition, ToolOutput } from '../engine/types.js'

const GrepInput = z.object({
  pattern: z.string(),
  path: z.string().optional(),
  glob: z.string().optional(),
  case_insensitive: z.boolean().default(false),
})
const OUTPUT_CAP = 30_000

export const grepTool: ToolDefinition<z.infer<typeof GrepInput>> = {
  name: 'Grep',
  description: 'Content search via ripgrep. Full regex syntax. Returns file:line:text matches.',
  schema: GrepInput,
  readOnly: true,
  execute(input, ctx): Promise<ToolOutput> {
    const args = ['--line-number', '--no-heading', '--color', 'never', '--max-columns', '500']
    if (input.case_insensitive) args.push('-i')
    if (input.glob) args.push('--glob', input.glob)
    args.push('--', input.pattern, resolve(ctx.cwd, input.path ?? '.'))
    return new Promise((resolvePromise) => {
      const child = spawn(rgPath, args, { signal: ctx.abortSignal })
      let out = ''
      let err = ''
      child.stdout.on('data', (d: Buffer) => { out += d.toString('utf8') })
      child.stderr.on('data', (d: Buffer) => { err += d.toString('utf8') })
      child.on('error', (e) => resolvePromise({ output: `ripgrep failed to start: ${e.message}`, isError: true }))
      child.on('close', (code) => {
        if (code === 1) return resolvePromise({ output: 'No matches found.', isError: false })
        if (code !== 0) return resolvePromise({ output: `ripgrep exited ${code}: ${err.trim()}`, isError: true })
        const capped = out.length > OUTPUT_CAP
          ? out.slice(0, OUTPUT_CAP) + `\n(truncated: output exceeded ${OUTPUT_CAP} chars)`
          : out
        resolvePromise({ output: capped.trimEnd(), isError: false })
      })
    })
  },
}
```

- [ ] Write `src/tools/registry.ts` — the seam the spec requires for future MCP providers:

```ts
import type { ToolDefinition } from '../engine/types.js'

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition<never>>()

  register(tool: ToolDefinition<never>): void {
    if (this.tools.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`)
    this.tools.set(tool.name, tool)
  }

  get(name: string): ToolDefinition<never> | undefined { return this.tools.get(name) }
  list(): ToolDefinition<never>[] { return [...this.tools.values()] }

  /** Restricted copy for sub-agents (Task 12). names=null keeps all tools. */
  restrict(names: string[] | null, exclude: string[] = []): ToolRegistry {
    const next = new ToolRegistry()
    for (const t of this.list()) {
      if (exclude.includes(t.name)) continue
      if (names === null || names.includes(t.name)) next.register(t)
    }
    return next
  }
}
```

- [ ] Update `src/tools/index.ts` to export the five tools + registry.
- [ ] Run `pnpm test tests/tools` — expect all passing (Grep tests exercise the real bundled rg binary). `pnpm typecheck && pnpm lint`.
- [ ] Commit:

```
git add src/tools/read.ts src/tools/write.ts src/tools/edit.ts src/tools/glob.ts src/tools/grep.ts src/tools/registry.ts src/tools/index.ts tests/tools/read.test.ts tests/tools/write.test.ts tests/tools/edit.test.ts tests/tools/glob.test.ts tests/tools/grep.test.ts tests/helpers/tool-ctx.ts
git commit -m "feat(tools): Read/Write/Edit/Glob/Grep with read-before-write and edit uniqueness enforcement

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 5: Shell + utility tools (Bash, PowerShell, TodoWrite, Memory)

**Files:**
- Create: `src/tools/shell.ts`, `src/tools/todo.ts`, `src/tools/memory.ts`
- Modify: `src/tools/index.ts`
- Test: `tests/tools/shell.test.ts`, `tests/tools/todo.test.ts`, `tests/tools/memory.test.ts`

**Steps:**

- [ ] Write failing tests:

```ts
// shell.test.ts — key cases
it('runs a command and returns stdout', async () => {
  const res = await powershellTool.execute({ command: 'Write-Output hello' }, makeCtx(dir))
  expect(res.output).toContain('hello')
  expect(res.isError).toBe(false)
})
it('nonzero exit returns isError true with exit code in output', async () => { /* exit 3 */ })
it('kills the process at timeout and says so', async () => { /* Start-Sleep 10 with timeoutMs 500 -> isError, /timed out/ */ })
it('caps combined output at 30000 chars with a truncation notice', async () => { /* loop printing 40k chars */ })
it('rejects timeout above 600000ms via schema', () => {
  expect(powershellTool.schema.safeParse({ command: 'x', timeout: 700_000 }).success).toBe(false)
})
it('background mode returns a task id immediately and later emits a tool-result event', async () => {
  const ctx = makeCtx(dir)
  const res = await powershellTool.execute({ command: 'Write-Output done', run_in_background: true }, ctx)
  expect(res.output).toMatch(/^Started background task bg-/)
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'tool-result' && e.output.includes('done'))).toBe(true)
  })
})

// todo.test.ts
it('stores todos in ctx and emits todo-update', async () => {
  const ctx = makeCtx(dir)
  const todos = [{ text: 'a', status: 'pending' as const }]
  const res = await todoTool.execute({ todos }, ctx)
  expect(res.isError).toBe(false)
  expect(ctx.todos).toEqual(todos)
  expect(ctx.events).toContainEqual({ type: 'todo-update', todos })
})

// memory.test.ts
it('write creates the file and appends an index line to MEMORY.md', async () => { /* op write, path "facts/x.md" -> file exists, MEMORY.md contains "[facts/x.md]" */ })
it('list returns relative paths, read returns content, delete removes file and index line', async () => { /* full round-trip */ })
it('rejects paths escaping the memory dir', async () => {
  const res = await memoryTool.execute({ op: 'read', path: '../settings.json' }, ctx)
  expect(res.isError).toBe(true)
})
```

- [ ] Run tests — expect failures.
- [ ] Write `src/tools/shell.ts`. Full factory; both tools come from it:

```ts
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ToolDefinition, ToolOutput, ToolContext } from '../engine/types.js'

const ShellInput = z.object({
  command: z.string(),
  timeout: z.number().int().positive().max(600_000).default(120_000),
  run_in_background: z.boolean().default(false),
})
type ShellInputT = z.infer<typeof ShellInput>
const OUTPUT_CAP = 30_000

interface ShellSpec { name: 'Bash' | 'PowerShell'; bin: string; args: (cmd: string) => string[] }

const SPECS: ShellSpec[] = [
  { name: 'Bash', bin: 'bash.exe', args: (cmd) => ['-c', cmd] },
  { name: 'PowerShell', bin: 'powershell.exe', args: (cmd) => ['-NoProfile', '-NonInteractive', '-Command', cmd] },
]

function cap(s: string): string {
  return s.length > OUTPUT_CAP ? s.slice(0, OUTPUT_CAP) + `\n(truncated: output exceeded ${OUTPUT_CAP} chars)` : s
}

function runShell(spec: ShellSpec, input: ShellInputT, ctx: ToolContext): Promise<ToolOutput> {
  return new Promise((resolvePromise) => {
    const child = spawn(spec.bin, spec.args(input.command), { cwd: ctx.cwd, windowsHide: true })
    let out = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill() }, input.timeout)
    const onAbort = () => child.kill()
    ctx.abortSignal.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (d: Buffer) => { out += d.toString('utf8') })
    child.stderr.on('data', (d: Buffer) => { out += d.toString('utf8') })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolvePromise({ output: `${spec.name} unavailable (${spec.bin}): ${e.message}`, isError: true })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      ctx.abortSignal.removeEventListener('abort', onAbort)
      if (timedOut) return resolvePromise({ output: cap(out) + `\n(command timed out after ${input.timeout}ms)`, isError: true })
      resolvePromise({ output: cap(out) || '(no output)', isError: code !== 0 ? true : false })
    })
  })
}

export interface BackgroundTask { id: string; command: string; status: 'running' | 'done' | 'failed'; output: string }
export const backgroundTasks = new Map<string, BackgroundTask>()

function makeShellTool(spec: ShellSpec): ToolDefinition<ShellInputT> {
  return {
    name: spec.name,
    description: `Execute a command via ${spec.name}. Default timeout 120s, max 600s. Set run_in_background for long-running commands; completion is reported as a tool-result event.`,
    schema: ShellInput,
    readOnly: false,
    async execute(input, ctx) {
      if (!input.run_in_background) return runShell(spec, input, ctx)
      const id = `bg-${randomUUID().slice(0, 8)}`
      const task: BackgroundTask = { id, command: input.command, status: 'running', output: '' }
      backgroundTasks.set(id, task)
      void runShell(spec, { ...input, run_in_background: false }, ctx).then((res) => {
        task.status = res.isError ? 'failed' : 'done'
        task.output = res.output
        ctx.emit({ type: 'tool-result', id, name: spec.name, output: `[background ${id} ${task.status}]\n${res.output}`, isError: res.isError })
      })
      return { output: `Started background task ${id}: ${input.command}`, isError: false }
    },
  }
}

export const bashTool = makeShellTool(SPECS[0]!)
export const powershellTool = makeShellTool(SPECS[1]!)
```

- [ ] Write `src/tools/todo.ts` (full):

```ts
import { z } from 'zod'
import type { ToolDefinition, TodoItem } from '../engine/types.js'

const TodoInput = z.object({
  todos: z.array(z.object({
    text: z.string().min(1),
    status: z.enum(['pending', 'in_progress', 'done']),
  })),
})

export const todoTool: ToolDefinition<z.infer<typeof TodoInput>> = {
  name: 'TodoWrite',
  description: 'Replace the session task list. Rendered live in the TUI.',
  schema: TodoInput,
  readOnly: true,
  async execute(input, ctx) {
    const todos: TodoItem[] = input.todos
    ctx.todos.length = 0
    ctx.todos.push(...todos)
    ctx.emit({ type: 'todo-update', todos })
    return { output: `Todo list updated (${todos.length} items).`, isError: false }
  },
}
```

- [ ] Write `src/tools/memory.ts` (full — index maintenance is the load-bearing logic):

```ts
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, relative, dirname, sep } from 'node:path'
import { z } from 'zod'
import type { ToolDefinition } from '../engine/types.js'

const MemoryInput = z.object({
  op: z.enum(['list', 'read', 'write', 'delete']),
  path: z.string().optional(),          // relative to memory dir; required for read/write/delete
  content: z.string().optional(),       // required for write
  description: z.string().optional(),   // index line annotation for write
})

function memoryDirOf(brainDir: string): string { return join(brainDir, 'memory') }
function indexFileOf(brainDir: string): string { return join(memoryDirOf(brainDir), 'MEMORY.md') }

function safeResolve(memDir: string, rel: string): string | null {
  const abs = resolve(memDir, rel)
  return abs === memDir || abs.startsWith(memDir + sep) ? abs : null
}

function updateIndex(brainDir: string, rel: string, action: 'add' | 'remove', description: string): void {
  const idx = indexFileOf(brainDir)
  const lines = existsSync(idx) ? readFileSync(idx, 'utf8').split('\n') : ['# Memory Index', '']
  const marker = `](${rel.replaceAll('\\', '/')})`
  const filtered = lines.filter((l) => !l.includes(marker))
  if (action === 'add') filtered.push(`- [${rel.replaceAll('\\', '/')}](${rel.replaceAll('\\', '/')}) — ${description}`)
  mkdirSync(dirname(idx), { recursive: true })
  writeFileSync(idx, filtered.join('\n').trimEnd() + '\n', 'utf8')
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const e of readdirSync(dir)) {
    const full = join(dir, e)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

export const memoryTool: ToolDefinition<z.infer<typeof MemoryInput>> = {
  name: 'Memory',
  description: 'List, read, write, or delete Brain memory files (one fact per file). Writes and deletes keep MEMORY.md in sync.',
  schema: MemoryInput,
  readOnly: false,
  async execute(input, ctx) {
    const memDir = memoryDirOf(ctx.brainDir)
    if (input.op === 'list') {
      const files = walk(memDir).map((f) => relative(memDir, f).replaceAll('\\', '/'))
      return { output: files.length ? files.join('\n') : '(memory is empty)', isError: false }
    }
    if (!input.path) return { output: `op ${input.op} requires path`, isError: true }
    const abs = safeResolve(memDir, input.path)
    if (!abs) return { output: `Path escapes memory dir: ${input.path}`, isError: true }
    const rel = relative(memDir, abs)
    switch (input.op) {
      case 'read': {
        if (!existsSync(abs)) return { output: `No memory at ${rel}`, isError: true }
        return { output: readFileSync(abs, 'utf8'), isError: false }
      }
      case 'write': {
        if (input.content === undefined) return { output: 'write requires content', isError: true }
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, input.content, 'utf8')
        updateIndex(ctx.brainDir, rel, 'add', input.description ?? input.content.split('\n')[0] ?? '')
        return { output: `Memory written: ${rel} (index updated)`, isError: false }
      }
      case 'delete': {
        if (!existsSync(abs)) return { output: `No memory at ${rel}`, isError: true }
        rmSync(abs)
        updateIndex(ctx.brainDir, rel, 'remove', '')
        return { output: `Memory deleted: ${rel} (index updated)`, isError: false }
      }
    }
  },
}
```

- [ ] Run `pnpm test tests/tools` — all passing. `pnpm typecheck && pnpm lint`.
- [ ] Commit:

```
git add src/tools/shell.ts src/tools/todo.ts src/tools/memory.ts src/tools/index.ts tests/tools/shell.test.ts tests/tools/todo.test.ts tests/tools/memory.test.ts
git commit -m "feat(tools): Bash/PowerShell with timeout+background, TodoWrite, Memory with index sync

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 6: Web tools (WebFetch, WebSearch)

**Files:**
- Create: `src/tools/webfetch.ts`, `src/tools/websearch.ts`
- Modify: `src/tools/index.ts`
- Test: `tests/tools/webfetch.test.ts`, `tests/tools/websearch.test.ts`

**Steps:**

- [ ] Write failing tests using `vi.stubGlobal('fetch', ...)`:

```ts
// webfetch.test.ts
it('strips HTML to readable text', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    '<html><head><style>.x{}</style><script>bad()</script></head><body><h1>Title</h1><p>Hello &amp; world</p></body></html>',
    { status: 200, headers: { 'content-type': 'text/html' } })))
  const res = await webfetchTool.execute({ url: 'https://example.com' }, makeCtx(dir))
  expect(res.isError).toBe(false)
  expect(res.output).toContain('Title')
  expect(res.output).toContain('Hello & world')
  expect(res.output).not.toContain('bad()')
})
it('caps output at 50000 chars with a truncation notice', async () => { /* 80k-char body */ })
it('returns isError on HTTP failure status', async () => { /* 404 -> isError true, "404" in output */ })
it('returns isError on timeout/network failure', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('timeout', 'TimeoutError') }))
  const res = await webfetchTool.execute({ url: 'https://slow.example' }, makeCtx(dir))
  expect(res.isError).toBe(true)
})

// websearch.test.ts
it('parses DuckDuckGo result anchors into title/url/snippet triples', async () => {
  const html = '<div class="result"><a class="result__a" href="https://a.example/page">First Hit</a>' +
    '<a class="result__snippet" href="#">Snippet text here</a></div>'
  vi.stubGlobal('fetch', vi.fn(async () => new Response(html, { status: 200 })))
  const res = await websearchTool.execute({ query: 'athena harness' }, makeCtx(dir))
  expect(res.isError).toBe(false)
  expect(res.output).toContain('First Hit')
  expect(res.output).toContain('https://a.example/page')
  expect(res.output).toContain('Snippet text here')
})
it('degrades gracefully when fetch throws (no crash, informative message)', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
  const res = await websearchTool.execute({ query: 'x' }, makeCtx(dir))
  expect(res.isError).toBe(true)
  expect(res.output).toMatch(/search unavailable/i)
})
it('reports zero results without error', async () => { /* empty html -> isError false, "No results" */ })
```

- [ ] Run tests — expect failures.
- [ ] Write `src/tools/webfetch.ts` (full — HTML stripping is the load-bearing logic):

```ts
import { z } from 'zod'
import type { ToolDefinition } from '../engine/types.js'

const FetchInput = z.object({ url: z.string().url() })
const CAP = 50_000
const TIMEOUT_MS = 10_000

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*/g, '\n\n')
    .trim()
}

export const webfetchTool: ToolDefinition<z.infer<typeof FetchInput>> = {
  name: 'WebFetch',
  description: 'Fetch a URL (10s timeout) and return its readable text content, capped at 50k chars.',
  schema: FetchInput,
  readOnly: true,
  async execute(input) {
    try {
      const res = await fetch(input.url, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'user-agent': 'athena/0.1 (+terminal coding agent)' },
        redirect: 'follow',
      })
      if (!res.ok) return { output: `HTTP ${res.status} ${res.statusText} for ${input.url}`, isError: true }
      const raw = await res.text()
      const contentType = res.headers.get('content-type') ?? ''
      const text = contentType.includes('html') ? htmlToText(raw) : raw
      const capped = text.length > CAP ? text.slice(0, CAP) + `\n(truncated at ${CAP} chars)` : text
      return { output: capped, isError: false }
    } catch (err) {
      return { output: `Fetch failed for ${input.url}: ${(err as Error).message ?? String(err)}`, isError: true }
    }
  },
}
```

- [ ] Write `src/tools/websearch.ts` (full):

```ts
import { z } from 'zod'
import type { ToolDefinition } from '../engine/types.js'
import { htmlToText } from './webfetch.js'

const SearchInput = z.object({ query: z.string().min(1), max_results: z.number().int().min(1).max(20).default(8) })

interface SearchHit { title: string; url: string; snippet: string }

export function parseDuckDuckGoHtml(html: string, max: number): SearchHit[] {
  const hits: SearchHit[] = []
  const anchorRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g
  const snippets = [...html.matchAll(snippetRe)].map((m) => htmlToText(m[1]!))
  let m: RegExpExecArray | null
  let i = 0
  while ((m = anchorRe.exec(html)) !== null && hits.length < max) {
    let url = m[1]!
    // DDG wraps targets as //duckduckgo.com/l/?uddg=<encoded>
    const uddg = /[?&]uddg=([^&]+)/.exec(url)
    if (uddg) url = decodeURIComponent(uddg[1]!)
    hits.push({ title: htmlToText(m[2]!), url, snippet: snippets[i] ?? '' })
    i += 1
  }
  return hits
}

export const websearchTool: ToolDefinition<z.infer<typeof SearchInput>> = {
  name: 'WebSearch',
  description: 'Web search (DuckDuckGo). Returns title, url, and snippet per result.',
  schema: SearchInput,
  readOnly: true,
  async execute(input) {
    try {
      const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(input.query)}`, {
        signal: AbortSignal.timeout(10_000),
        headers: { 'user-agent': 'athena/0.1 (+terminal coding agent)' },
      })
      if (!res.ok) return { output: `Search unavailable: HTTP ${res.status}`, isError: true }
      const hits = parseDuckDuckGoHtml(await res.text(), input.max_results)
      if (hits.length === 0) return { output: `No results for: ${input.query}`, isError: false }
      const out = hits.map((h, n) => `${n + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join('\n')
      return { output: out, isError: false }
    } catch (err) {
      return { output: `Search unavailable: ${(err as Error).message ?? String(err)}`, isError: true }
    }
  },
}
```

- [ ] Run `pnpm test tests/tools/webfetch.test.ts tests/tools/websearch.test.ts` — all passing. `pnpm typecheck && pnpm lint`.
- [ ] Commit:

```
git add src/tools/webfetch.ts src/tools/websearch.ts src/tools/index.ts tests/tools/webfetch.test.ts tests/tools/websearch.test.ts
git commit -m "feat(tools): WebFetch with readable extraction and WebSearch via DuckDuckGo HTML

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 7: Permission engine

**Files:**
- Create: `src/harness/permissions.ts`
- Modify: `src/harness/index.ts`
- Test: `tests/harness/permissions.test.ts`

**Steps:**

- [ ] Write failing table-driven test `tests/harness/permissions.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { PermissionEngine, matchesRule, parseRule } from '../../src/harness/permissions.js'
import type { PermissionMode, PermissionRequest } from '../../src/engine/types.js'

function req(toolName: string, input: unknown, readOnly: boolean): PermissionRequest {
  return { toolName, input, readOnly, summary: `${toolName}` }
}

describe('parseRule / matchesRule', () => {
  const cases: Array<[rule: string, tool: string, input: unknown, expected: boolean]> = [
    ['Read(**)',        'Read',  { file_path: 'src/a.ts' }, true],
    ['Read(**)',        'Write', { file_path: 'src/a.ts' }, false],
    ['Edit(src/**)',    'Edit',  { file_path: 'src/deep/x.ts', old_string: 'a', new_string: 'b' }, true],
    ['Edit(src/**)',    'Edit',  { file_path: 'docs/x.md', old_string: 'a', new_string: 'b' }, false],
    ['Bash(git:*)',     'Bash',  { command: 'git status' }, true],
    ['Bash(git:*)',     'Bash',  { command: 'git commit -m x' }, true],
    ['Bash(git:*)',     'Bash',  { command: 'gitk' }, false],          // prefix is word-bounded
    ['Bash(git:*)',     'Bash',  { command: 'rm -rf /' }, false],
    ['Bash(pnpm test:*)', 'Bash', { command: 'pnpm test tests/x' }, true],
    ['Grep',            'Grep',  { pattern: 'x' }, true],              // bare tool rule matches any input
    ['Glob(*.ts)',      'Glob',  { pattern: 'a.ts' }, true],
    ['Glob(*.ts)',      'Glob',  { pattern: 'src/a.ts' }, false],      // * does not cross /
  ]
  it.each(cases)('%s vs %s %j -> %s', (rule, tool, input, expected) => {
    expect(matchesRule(parseRule(rule), tool, input)).toBe(expected)
  })
})

describe('PermissionEngine precedence and modes', () => {
  const table: Array<{
    name: string
    mode: PermissionMode
    allow?: string[]
    deny?: string[]
    request: PermissionRequest
    expected: 'allow' | 'deny' | 'ask'
  }> = [
    { name: 'readOnly always allowed in normal', mode: 'normal', request: req('Read', { file_path: 'x' }, true), expected: 'allow' },
    { name: 'mutating asks in normal', mode: 'normal', request: req('Write', { file_path: 'x', content: '' }, false), expected: 'ask' },
    { name: 'allow rule beats normal-mode ask', mode: 'normal', allow: ['Write(src/**)'], request: req('Write', { file_path: 'src/x.ts', content: '' }, false), expected: 'allow' },
    { name: 'deny beats allow', mode: 'trusted', allow: ['Bash(git:*)'], deny: ['Bash(git:*)'], request: req('Bash', { command: 'git push' }, false), expected: 'deny' },
    { name: 'deny beats trusted mode', mode: 'trusted', deny: ['Bash(rm:*)'], request: req('Bash', { command: 'rm -rf x' }, false), expected: 'deny' },
    { name: 'acceptEdits auto-approves Write/Edit', mode: 'acceptEdits', request: req('Edit', { file_path: 'x', old_string: 'a', new_string: 'b' }, false), expected: 'allow' },
    { name: 'acceptEdits still asks for shell', mode: 'acceptEdits', request: req('Bash', { command: 'echo hi' }, false), expected: 'ask' },
    { name: 'plan blocks mutating tools outright', mode: 'plan', request: req('Write', { file_path: 'x', content: '' }, false), expected: 'deny' },
    { name: 'plan allows readOnly', mode: 'plan', request: req('Grep', { pattern: 'x' }, true), expected: 'allow' },
    { name: 'trusted allows mutating without rules', mode: 'trusted', request: req('Bash', { command: 'echo hi' }, false), expected: 'allow' },
  ]
  it.each(table)('$name', ({ mode, allow = [], deny = [], request, expected }) => {
    const engine = new PermissionEngine({ mode, allow, deny })
    expect(engine.check(request).decision).toBe(expected)
  })

  it('grantSession adds a live allow rule', () => {
    const engine = new PermissionEngine({ mode: 'normal', allow: [], deny: [] })
    expect(engine.check(req('Bash', { command: 'git status' }, false)).decision).toBe('ask')
    engine.grantSession('Bash(git:*)')
    expect(engine.check(req('Bash', { command: 'git status' }, false)).decision).toBe('allow')
  })

  it('setMode switches behavior live', () => {
    const engine = new PermissionEngine({ mode: 'normal', allow: [], deny: [] })
    engine.setMode('plan')
    expect(engine.check(req('Write', { file_path: 'x', content: '' }, false)).decision).toBe('deny')
  })
})
```

- [ ] Run — expect failure.
- [ ] Write `src/harness/permissions.ts` (full — matcher logic printed in full):

```ts
import type { PermissionDecision, PermissionGate, PermissionMode, PermissionRequest } from '../engine/types.js'

export interface ParsedRule { tool: string; pattern: string | null }

export function parseRule(rule: string): ParsedRule {
  const m = /^([A-Za-z][\w-]*)(?:\((.*)\))?$/.exec(rule.trim())
  if (!m) throw new Error(`Malformed permission rule: ${rule}`)
  return { tool: m[1]!, pattern: m[2] ?? null }
}

/** Glob-ish matcher: ** crosses path separators, * does not, ? is one char. */
export function globToRegExp(pattern: string): RegExp {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!
    if (c === '*') {
      if (pattern[i + 1] === '*') { re += '.*'; i += 1 } else { re += '[^/\\\\]*' }
    } else if (c === '?') {
      re += '.'
    } else {
      re += /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c
    }
  }
  return new RegExp(`^${re}$`)
}

/** The string a rule pattern is matched against, per tool. */
export function matchTarget(toolName: string, input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>
  if (toolName === 'Bash' || toolName === 'PowerShell') return String(obj['command'] ?? '')
  if (typeof obj['file_path'] === 'string') return (obj['file_path'] as string).replaceAll('\\', '/')
  if (typeof obj['pattern'] === 'string') return obj['pattern'] as string
  if (typeof obj['url'] === 'string') return obj['url'] as string
  return JSON.stringify(input)
}

export function matchesRule(rule: ParsedRule, toolName: string, input: unknown): boolean {
  if (rule.tool !== toolName) return false
  if (rule.pattern === null) return true
  const target = matchTarget(toolName, input)
  if (toolName === 'Bash' || toolName === 'PowerShell') {
    // Command-prefix semantics: "git:*" matches "git" or "git <anything>", never "gitk".
    const prefix = rule.pattern.endsWith(':*') ? rule.pattern.slice(0, -2) : rule.pattern
    return target === prefix || target.startsWith(prefix + ' ')
  }
  return globToRegExp(rule.pattern).test(target)
}

const EDIT_TOOLS = new Set(['Write', 'Edit'])

export interface PermissionEngineOptions { mode: PermissionMode; allow: string[]; deny: string[] }

export class PermissionEngine implements PermissionGate {
  private mode: PermissionMode
  private readonly allowRules: ParsedRule[]
  private readonly denyRules: ParsedRule[]
  private readonly sessionGrants: ParsedRule[] = []

  constructor(opts: PermissionEngineOptions) {
    this.mode = opts.mode
    this.allowRules = opts.allow.map(parseRule)
    this.denyRules = opts.deny.map(parseRule)
  }

  setMode(mode: PermissionMode): void { this.mode = mode }
  getMode(): PermissionMode { return this.mode }

  grantSession(rule: string): void { this.sessionGrants.push(parseRule(rule)) }

  check(req: PermissionRequest): PermissionDecision {
    // 1. Hard deny — no mode bypasses it.
    for (const rule of this.denyRules) {
      if (matchesRule(rule, req.toolName, req.input)) {
        return { decision: 'deny', reason: `Denied by rule ${rule.tool}(${rule.pattern ?? ''})` }
      }
    }
    // 2. Plan mode: read-only tools only; mutating tools are denied, not asked.
    if (this.mode === 'plan') {
      return req.readOnly
        ? { decision: 'allow', reason: 'Read-only tool in plan mode' }
        : { decision: 'deny', reason: 'Plan mode: mutating tools are disabled' }
    }
    // 3. Read-only tools never prompt.
    if (req.readOnly) return { decision: 'allow', reason: 'Read-only tool' }
    // 4. Explicit allow rules + session grants.
    for (const rule of [...this.allowRules, ...this.sessionGrants]) {
      if (matchesRule(rule, req.toolName, req.input)) {
        return { decision: 'allow', reason: `Allowed by rule ${rule.tool}(${rule.pattern ?? ''})` }
      }
    }
    // 5. Mode defaults.
    if (this.mode === 'trusted') return { decision: 'allow', reason: 'Trusted mode' }
    if (this.mode === 'acceptEdits' && EDIT_TOOLS.has(req.toolName)) {
      return { decision: 'allow', reason: 'acceptEdits mode auto-approves file edits' }
    }
    return { decision: 'ask', reason: `${req.toolName} is mutating; no rule matched in ${this.mode} mode` }
  }
}
```

- [ ] Run `pnpm test tests/harness/permissions.test.ts` — all passing. `pnpm typecheck && pnpm lint`.
- [ ] Commit:

```
git add src/harness/permissions.ts src/harness/index.ts tests/harness/permissions.test.ts
git commit -m "feat(harness): permission engine with modes, Tool(pattern) rules, deny>allow>mode precedence

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 8: Hook runner

**Files:**
- Create: `src/harness/hooks.ts`
- Modify: `src/harness/index.ts`
- Test: `tests/harness/hooks.test.ts`

**Steps:**

- [ ] Write failing test `tests/harness/hooks.test.ts` using `node -e` one-liners as hook commands:

```ts
import { describe, it, expect } from 'vitest'
import { HookRunner } from '../../src/harness/hooks.js'
import type { HookDef } from '../../src/brain/settings.js'

const node = process.execPath
function hook(partial: Partial<HookDef> & Pick<HookDef, 'event' | 'command'>): HookDef {
  return { timeoutMs: 5_000, ...partial }
}

describe('HookRunner', () => {
  it('exit 0 allows and stdout JSON annotates context', async () => {
    const runner = new HookRunner([hook({
      event: 'PreToolUse',
      command: `"${node}" -e "console.log(JSON.stringify({addedContext:'from-hook'}));process.exit(0)"`,
    })])
    const out = await runner.run('PreToolUse', { toolName: 'Bash', input: { command: 'git status' } })
    expect(out.allowed).toBe(true)
    expect(out.addedContext).toBe('from-hook')
  })

  it('exit 2 denies with stderr as reason', async () => {
    const runner = new HookRunner([hook({
      event: 'PreToolUse',
      command: `"${node}" -e "console.error('blocked by gate');process.exit(2)"`,
    })])
    const out = await runner.run('PreToolUse', { toolName: 'Bash', input: { command: 'rm -rf' } })
    expect(out.allowed).toBe(false)
    expect(out.reason).toContain('blocked by gate')
  })

  it('hook receives the event JSON on stdin', async () => {
    const runner = new HookRunner([hook({
      event: 'PreToolUse',
      command: `"${node}" -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const e=JSON.parse(d);process.exit(e.toolName==='Edit'?2:0)})"`,
    })])
    expect((await runner.run('PreToolUse', { toolName: 'Edit', input: {} })).allowed).toBe(false)
    expect((await runner.run('PreToolUse', { toolName: 'Read', input: {} })).allowed).toBe(true)
  })

  it('PreToolUse process failure (crash/timeout/bad exit) fails CLOSED', async () => {
    const crash = new HookRunner([hook({ event: 'PreToolUse', command: `"${node}" -e "process.exit(1)"` })])
    expect((await crash.run('PreToolUse', { toolName: 'Bash', input: {} })).allowed).toBe(false)
    const timeout = new HookRunner([hook({ event: 'PreToolUse', timeoutMs: 300, command: `"${node}" -e "setTimeout(()=>{},60000)"` })])
    expect((await timeout.run('PreToolUse', { toolName: 'Bash', input: {} })).allowed).toBe(false)
  })

  it('non-PreToolUse process failure fails OPEN with a warning reason', async () => {
    const runner = new HookRunner([hook({ event: 'PostToolUse', command: `"${node}" -e "process.exit(1)"` })])
    const out = await runner.run('PostToolUse', { toolName: 'Bash', input: {} })
    expect(out.allowed).toBe(true)
    expect(out.reason).toMatch(/hook failed/i)
  })

  it('matcher restricts a hook to matching tools; * matches all', async () => {
    const runner = new HookRunner([hook({
      event: 'PreToolUse', matcher: 'Bash',
      command: `"${node}" -e "process.exit(2)"`,
    })])
    expect((await runner.run('PreToolUse', { toolName: 'Bash', input: {} })).allowed).toBe(false)
    expect((await runner.run('PreToolUse', { toolName: 'Read', input: {} })).allowed).toBe(true)
  })

  it('no hooks registered for an event -> allowed', async () => {
    expect((await new HookRunner([]).run('Stop', {})).allowed).toBe(true)
  })
})
```

- [ ] Run — expect failure.
- [ ] Write `src/harness/hooks.ts` (full — the hook protocol is the load-bearing logic):

```ts
import { spawn } from 'node:child_process'
import type { HookEventName, HookOutcome } from '../engine/types.js'
import type { HookDef } from '../brain/settings.js'

export interface HookEventPayload { toolName?: string; input?: unknown; output?: string; prompt?: string; [k: string]: unknown }

interface HookProcessResult { code: number | null; stdout: string; stderr: string; failed: boolean; failure?: string }

function runProcess(command: string, payloadJson: string, timeoutMs: number): Promise<HookProcessResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, { shell: true, windowsHide: true })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (r: HookProcessResult) => { if (!settled) { settled = true; resolvePromise(r) } }
    const timer = setTimeout(() => {
      child.kill()
      finish({ code: null, stdout, stderr, failed: true, failure: `hook timed out after ${timeoutMs}ms` })
    }, timeoutMs)
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
    child.on('error', (e) => { clearTimeout(timer); finish({ code: null, stdout, stderr, failed: true, failure: e.message }) })
    child.on('close', (code) => { clearTimeout(timer); finish({ code, stdout, stderr, failed: false }) })
    child.stdin.write(payloadJson)
    child.stdin.end()
  })
}

export class HookRunner {
  constructor(private readonly hooks: HookDef[]) {}

  private select(event: HookEventName, toolName: string | undefined): HookDef[] {
    return this.hooks.filter((h) => {
      if (h.event !== event) return false
      if (!h.matcher || h.matcher === '*') return true
      if (toolName === undefined) return true
      return h.matcher.split('|').map((s) => s.trim()).includes(toolName)
    })
  }

  /** Runs every matching hook in declaration order. First deny wins. addedContext concatenates. */
  async run(event: HookEventName, payload: HookEventPayload): Promise<HookOutcome> {
    const matching = this.select(event, payload.toolName)
    const contexts: string[] = []
    const warnings: string[] = []
    const json = JSON.stringify({ event, ...payload })
    for (const hookDef of matching) {
      const result = await runProcess(hookDef.command, json, hookDef.timeoutMs)
      const processFailed = result.failed || (result.code !== 0 && result.code !== 2)
      if (processFailed) {
        if (event === 'PreToolUse') {
          // A broken gate blocks, not bypasses.
          return { allowed: false, reason: `PreToolUse hook failed (${result.failure ?? `exit ${result.code}`}); failing closed. Command: ${hookDef.command}` }
        }
        warnings.push(`hook failed (${result.failure ?? `exit ${result.code}`}): ${hookDef.command}`)
        continue
      }
      if (result.code === 2) {
        return { allowed: false, reason: result.stderr.trim() || `Denied by hook: ${hookDef.command}` }
      }
      // exit 0: optional stdout JSON annotation
      const trimmed = result.stdout.trim()
      if (trimmed) {
        try {
          const parsed = JSON.parse(trimmed) as { addedContext?: string }
          if (parsed.addedContext) contexts.push(parsed.addedContext)
        } catch { /* non-JSON stdout is ignored */ }
      }
    }
    return {
      allowed: true,
      reason: warnings.length ? `hook failed (fail-open): ${warnings.join('; ')}` : undefined,
      addedContext: contexts.length ? contexts.join('\n') : undefined,
    }
  }
}
```

- [ ] Run `pnpm test tests/harness/hooks.test.ts` — all passing. `pnpm typecheck && pnpm lint`.
- [ ] Commit:

```
git add src/harness/hooks.ts src/harness/index.ts tests/harness/hooks.test.ts
git commit -m "feat(harness): hook runner with stdin JSON protocol, fail-closed PreToolUse gates

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 9: Prompt assembly + context management

**Files:**
- Create: `src/engine/prompt.ts`, `src/engine/context.ts`
- Modify: `src/engine/index.ts`
- Test: `tests/engine/prompt.test.ts`, `tests/engine/context.test.ts`

**Steps:**

- [ ] Write failing test `tests/engine/prompt.test.ts`:

```ts
it('assembles sections in spec order: constitution, memory index, project context, tool guidance, environment', () => {
  const prompt = assembleSystemPrompt({
    constitution: '# ATHENA\nI am Athena.',
    memoryIndex: '# Memory Index\n- [x](x.md) — fact',
    projectContext: [{ file: 'C:/proj/CLAUDE.md', content: 'Project rules' }],
    toolGuidance: 'Use Read before Edit.',
    environment: { cwd: 'C:/proj', platform: 'win32', gitBranch: 'main', date: '2026-07-21' },
  })
  const order = ['I am Athena', 'Memory Index', 'Project rules', 'Use Read before Edit', 'cwd: C:/proj']
  const positions = order.map((s) => prompt.indexOf(s))
  expect(positions.every((p) => p >= 0)).toBe(true)
  expect([...positions]).toEqual([...positions].sort((a, b) => a - b))
})
it('omits absent sections without leaving empty headers', () => { /* constitution: null -> no "Constitution" header */ })

it('findProjectContextFiles walks up from cwd collecting CLAUDE.md / AGENTS.md / ATHENA.md, nearest last', () => {
  /* temp tree: root/CLAUDE.md and root/sub/AGENTS.md; cwd=root/sub -> [root/CLAUDE.md, root/sub/AGENTS.md] */
})
```

- [ ] Write failing test `tests/engine/context.test.ts` with a mocked summarizer client:

```ts
it('needsCompaction triggers at 80% of the model window', () => {
  const mgr = new ContextManager({ modelWindowTokens: 1000 })
  mgr.update({ inputTokens: 700, outputTokens: 99, cacheReadTokens: 0 })
  expect(mgr.needsCompaction()).toBe(false)
  mgr.update({ inputTokens: 700, outputTokens: 101, cacheReadTokens: 0 })
  expect(mgr.needsCompaction()).toBe(true)   // 801 >= 800
})

it('compact keeps the recent tail intact and replaces older messages with one summary message', async () => {
  const summarize = vi.fn(async () => 'SUMMARY: decided X; modified src/a.ts')
  const mgr = new ContextManager({ modelWindowTokens: 1000, keepRecentMessages: 4 })
  const messages = makeMessages(10)   // helper building alternating user/assistant text messages m0..m9
  const { messages: next, summary } = await mgr.compact(messages, summarize)
  expect(summary).toContain('decided X')
  expect(next).toHaveLength(5)                       // 1 summary + 4 tail
  expect(next[0]!.role).toBe('user')
  expect(String(next[0]!.content)).toContain('SUMMARY: decided X')
  expect(next.slice(1)).toEqual(messages.slice(6))   // tail untouched
})

it('the summarization prompt demands decisions and files-modified sections', async () => {
  const summarize = vi.fn(async (prompt: string) => {
    expect(prompt).toMatch(/Decisions made/i)
    expect(prompt).toMatch(/Files modified/i)
    return 'ok'
  })
  await new ContextManager({ modelWindowTokens: 1000 }).compact(makeMessages(10), summarize)
  expect(summarize).toHaveBeenCalledOnce()
})
```

- [ ] Run — expect failures.
- [ ] Write `src/engine/prompt.ts` (full):

```ts
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

export interface EnvironmentInfo { cwd: string; platform: string; gitBranch: string | null; date: string }
export interface ProjectContextFile { file: string; content: string }

export interface PromptParts {
  constitution: string | null
  memoryIndex: string | null
  projectContext: ProjectContextFile[]
  toolGuidance: string
  environment: EnvironmentInfo
}

const PROJECT_CONTEXT_NAMES = ['CLAUDE.md', 'AGENTS.md', 'ATHENA.md']

/** Walks up from cwd to the filesystem root; returns outermost-first so the nearest file lands last (highest salience). */
export function findProjectContextFiles(cwd: string): ProjectContextFile[] {
  const found: ProjectContextFile[] = []
  let dir = cwd
  for (;;) {
    for (const name of PROJECT_CONTEXT_NAMES) {
      const file = join(dir, name)
      if (existsSync(file)) found.push({ file, content: readFileSync(file, 'utf8') })
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return found.reverse()
}

export function assembleSystemPrompt(parts: PromptParts): string {
  const sections: string[] = []
  if (parts.constitution) sections.push(parts.constitution.trim())
  if (parts.memoryIndex) sections.push(`# Memory\n\n${parts.memoryIndex.trim()}`)
  for (const pc of parts.projectContext) {
    sections.push(`# Project context (${pc.file})\n\n${pc.content.trim()}`)
  }
  if (parts.toolGuidance) sections.push(`# Tool guidance\n\n${parts.toolGuidance.trim()}`)
  const env = parts.environment
  sections.push([
    '# Environment',
    '',
    `cwd: ${env.cwd}`,
    `platform: ${env.platform}`,
    `git branch: ${env.gitBranch ?? '(not a git repo)'}`,
    `date: ${env.date}`,
  ].join('\n'))
  return sections.join('\n\n---\n\n')
}
```

- [ ] Write `src/engine/context.ts` (full — compaction message construction printed in full):

```ts
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import type { TokenUsage } from './types.js'

export type Summarizer = (prompt: string) => Promise<string>

export interface ContextManagerOptions {
  modelWindowTokens: number
  compactionThreshold?: number      // fraction of window; default 0.8
  keepRecentMessages?: number       // tail kept verbatim; default 6
}

export class ContextManager {
  private readonly windowTokens: number
  private readonly threshold: number
  private readonly keepRecent: number
  private lastTotal = 0

  constructor(opts: ContextManagerOptions) {
    this.windowTokens = opts.modelWindowTokens
    this.threshold = opts.compactionThreshold ?? 0.8
    this.keepRecent = opts.keepRecentMessages ?? 6
  }

  /** Called with the usage block of each API response; input tokens already include the whole transcript. */
  update(usage: TokenUsage): void {
    this.lastTotal = usage.inputTokens + usage.cacheReadTokens + usage.outputTokens
  }

  usedFraction(): number { return this.lastTotal / this.windowTokens }
  needsCompaction(): boolean { return this.lastTotal >= this.threshold * this.windowTokens }

  buildSummaryPrompt(older: MessageParam[]): string {
    const transcript = older
      .map((m) => `[${m.role}] ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
      .join('\n')
    return [
      'Summarize the following conversation transcript into a compact hand-forward for a coding agent.',
      'You MUST preserve, as explicit sections:',
      '1. **Decisions made this session** — every decision, with its rationale in one line.',
      '2. **Files modified** — every file created, edited, or deleted, with a one-line description of the change.',
      '3. **Current state and next steps** — where the work stands and what remains.',
      'Do not restate the constitution or system rules; they are provided separately.',
      'Be dense. Omit pleasantries and tool noise.',
      '',
      '--- TRANSCRIPT ---',
      transcript,
    ].join('\n')
  }

  /** Replaces everything but the recent tail with one summary user message. Constitution survives in the system prompt untouched. */
  async compact(messages: MessageParam[], summarize: Summarizer): Promise<{ messages: MessageParam[]; summary: string }> {
    if (messages.length <= this.keepRecent) return { messages, summary: '' }
    const tail = messages.slice(-this.keepRecent)
    const older = messages.slice(0, -this.keepRecent)
    const summary = await summarize(this.buildSummaryPrompt(older))
    const summaryMessage: MessageParam = {
      role: 'user',
      content: `[Context compacted. Summary of the earlier conversation:]\n\n${summary}`,
    }
    this.lastTotal = 0   // stale until the next API response reports real usage
    return { messages: [summaryMessage, ...tail], summary }
  }
}
```

- [ ] Run `pnpm test tests/engine` — all passing. `pnpm typecheck && pnpm lint`.
- [ ] Commit:

```
git add src/engine/prompt.ts src/engine/context.ts src/engine/index.ts tests/engine/prompt.test.ts tests/engine/context.test.ts
git commit -m "feat(engine): ordered system prompt assembly and 80%-threshold context compaction

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 10: Engine loop + Anthropic client wrapper

**Files:**
- Create: `src/engine/client.ts`, `src/engine/loop.ts`
- Modify: `src/engine/index.ts`
- Test: `tests/helpers/mock-client.ts`, `tests/engine/loop.test.ts`

**Steps:**

- [ ] Write `src/engine/client.ts` FIRST (it defines the interface the mock implements):

```ts
import Anthropic from '@anthropic-ai/sdk'
import type { MessageParam, Message, Tool } from '@anthropic-ai/sdk/resources/messages'

export interface StreamCallbacks {
  onTextDelta: (delta: string) => void
  onThinkingDelta: (delta: string) => void
}

export interface StreamResult { message: Message }

/** The seam the engine depends on. Production impl wraps @anthropic-ai/sdk; tests script it. */
export interface ModelClient {
  stream(params: {
    model: string
    system: string
    messages: MessageParam[]
    tools: Tool[]
    maxTokens: number
    signal: AbortSignal
  }, callbacks: StreamCallbacks): Promise<StreamResult>
  /** One-shot non-streaming call used by the compactor. */
  complete(params: { model: string; prompt: string; maxTokens: number }): Promise<string>
}

const MAX_RETRIES = 3

export class AnthropicClient implements ModelClient {
  private readonly sdk: Anthropic
  constructor(apiKey?: string) { this.sdk = new Anthropic({ apiKey }) }

  async stream(params: Parameters<ModelClient['stream']>[0], callbacks: StreamCallbacks): Promise<StreamResult> {
    let lastError: unknown
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const stream = this.sdk.messages.stream({
          model: params.model,
          system: params.system,
          messages: params.messages,
          tools: params.tools,
          max_tokens: params.maxTokens,
        }, { signal: params.signal })
        stream.on('text', (delta) => callbacks.onTextDelta(delta))
        stream.on('thinking', (delta) => callbacks.onThinkingDelta(delta))
        return { message: await stream.finalMessage() }
      } catch (err) {
        lastError = err
        if (params.signal.aborted) throw err
        const status = (err as { status?: number }).status
        const retryable = status === 429 || status === 529 || (status !== undefined && status >= 500)
        if (!retryable || attempt === MAX_RETRIES - 1) throw err
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
      }
    }
    throw lastError
  }

  async complete(params: { model: string; prompt: string; maxTokens: number }): Promise<string> {
    const res = await this.sdk.messages.create({
      model: params.model,
      max_tokens: params.maxTokens,
      messages: [{ role: 'user', content: params.prompt }],
    })
    return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
  }
}
```

- [ ] Write `tests/helpers/mock-client.ts` (full — the scripted client every integration test uses):

```ts
import type { Message, MessageParam, ContentBlock } from '@anthropic-ai/sdk/resources/messages'
import type { ModelClient, StreamCallbacks, StreamResult } from '../../src/engine/client.js'

export interface ScriptedResponse { blocks: ContentBlock[]; stopReason: 'end_turn' | 'tool_use'; inputTokens?: number; outputTokens?: number }

export function textBlock(text: string): ContentBlock {
  return { type: 'text', text, citations: null } as ContentBlock
}
export function toolUseBlock(id: string, name: string, input: unknown): ContentBlock {
  return { type: 'tool_use', id, name, input } as ContentBlock
}

export class MockAnthropicClient implements ModelClient {
  readonly calls: MessageParam[][] = []
  private cursor = 0
  constructor(private readonly script: ScriptedResponse[]) {}

  async stream(params: { messages: MessageParam[]; signal: AbortSignal }, callbacks: StreamCallbacks): Promise<StreamResult> {
    if (params.signal.aborted) throw new DOMException('aborted', 'AbortError')
    this.calls.push(structuredClone(params.messages))
    const step = this.script[this.cursor]
    if (!step) throw new Error(`MockAnthropicClient script exhausted at call ${this.cursor}`)
    this.cursor += 1
    for (const block of step.blocks) {
      if (block.type === 'text') callbacks.onTextDelta(block.text)
    }
    const message: Message = {
      id: `msg_${this.cursor}`,
      type: 'message',
      role: 'assistant',
      model: 'mock',
      content: step.blocks,
      stop_reason: step.stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: step.inputTokens ?? 100,
        output_tokens: step.outputTokens ?? 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      } as Message['usage'],
    }
    return { message }
  }

  async complete(): Promise<string> { return 'mock summary' }
}
```

- [ ] Write failing test `tests/engine/loop.test.ts`:

```ts
function makeEngine(script: ScriptedResponse[], overrides: Partial<EngineOptions> = {}) {
  const bus = new EngineEventBus()
  const events: EngineEvent[] = []
  bus.on((e) => events.push(e))
  const registry = new ToolRegistry()
  registry.register(echoTool as ToolDefinition<never>)   // test-local tool echoing its input back
  const client = new MockAnthropicClient(script)
  const engine = new Engine({
    client, bus, registry,
    model: 'mock', systemPrompt: 'sys', maxTokens: 4096,
    gate: allowAllGate(), hooks: new HookRunner([]),
    contextManager: new ContextManager({ modelWindowTokens: 1_000_000 }),
    toolContext: makeCtx(process.cwd(), { emit: (e) => bus.emit(e) }),
    ...overrides,
  })
  return { engine, events, client }
}

it('text-only turn: streams deltas, appends assistant message, emits turn-done', async () => {
  const { engine, events } = makeEngine([{ blocks: [textBlock('Hello!')], stopReason: 'end_turn' }])
  await engine.runTurn('hi')
  expect(events).toContainEqual({ type: 'assistant-text', delta: 'Hello!' })
  expect(events.at(-1)).toMatchObject({ type: 'turn-done' })
  expect(engine.getMessages()).toHaveLength(2)   // user + assistant
})

it('tool round-trip: executes tool, feeds tool_result back, second call sees it', async () => {
  const { engine, events, client } = makeEngine([
    { blocks: [toolUseBlock('tu_1', 'Echo', { value: 'ping' })], stopReason: 'tool_use' },
    { blocks: [textBlock('done')], stopReason: 'end_turn' },
  ])
  await engine.runTurn('use the tool')
  expect(events).toContainEqual(expect.objectContaining({ type: 'tool-request', id: 'tu_1', name: 'Echo' }))
  expect(events).toContainEqual(expect.objectContaining({ type: 'tool-result', id: 'tu_1', isError: false }))
  const secondCall = client.calls[1]!
  const toolResultMsg = secondCall.at(-1)!
  expect(toolResultMsg.role).toBe('user')
  expect(JSON.stringify(toolResultMsg.content)).toContain('tu_1')
})

it('permission deny feeds an error tool_result to the model, loop continues', async () => {
  const denyGate: PermissionGate = {
    check: () => ({ decision: 'deny', reason: 'blocked by test' }),
    grantSession: () => {},
  }
  const { engine, events, client } = makeEngine([
    { blocks: [toolUseBlock('tu_1', 'Echo', { value: 'x' })], stopReason: 'tool_use' },
    { blocks: [textBlock('understood')], stopReason: 'end_turn' },
  ], { gate: denyGate })
  await engine.runTurn('go')
  expect(events).toContainEqual(expect.objectContaining({ type: 'tool-result', id: 'tu_1', isError: true }))
  expect(JSON.stringify(client.calls[1])).toContain('blocked by test')
})

it('parallel tool_use blocks execute sequentially in block order', async () => {
  /* two Echo blocks in one response; the echo tool records invocation order into an array; assert order */
})

it('abort mid-turn stops before the next model call and emits a non-fatal error event', async () => {
  const controller = new AbortController()
  /* echoTool variant that calls controller.abort() during execution; script has a 2nd step that must never run */
  const { engine, events, client } = makeEngine([
    { blocks: [toolUseBlock('tu_1', 'Echo', { value: 'abort-me' })], stopReason: 'tool_use' },
    { blocks: [textBlock('never')], stopReason: 'end_turn' },
  ], { abortController: controller })
  await engine.runTurn('go')
  expect(client.calls).toHaveLength(1)
  expect(events).toContainEqual(expect.objectContaining({ type: 'error', fatal: false }))
})
```

- [ ] Run — expect failures.
- [ ] Write `src/engine/loop.ts`. Complete class with the full turn state machine:

```ts
import type { MessageParam, Tool, ToolUseBlock } from '@anthropic-ai/sdk/resources/messages'
import { z } from 'zod'
import type { ModelClient } from './client.js'
import { EngineEventBus } from './events.js'
import { ContextManager } from './context.js'
import { ToolRegistry } from '../tools/registry.js'
import { HookRunner } from '../harness/hooks.js'
import type { PermissionGate, ToolContext, ToolOutput, TokenUsage } from './types.js'

export type AskUserFn = (req: { toolName: string; input: unknown; summary: string; reason: string }) =>
  Promise<'allow-once' | 'allow-always' | 'deny'>

export interface EngineOptions {
  client: ModelClient
  bus: EngineEventBus
  registry: ToolRegistry
  gate: PermissionGate
  hooks: HookRunner
  contextManager: ContextManager
  toolContext: ToolContext
  model: string
  systemPrompt: string
  maxTokens: number
  askUser?: AskUserFn                 // TUI wires this; headless default denies
  abortController?: AbortController
  onMessagesChanged?: (messages: MessageParam[]) => void   // session persistence seam (Task 11)
}

export class Engine {
  private messages: MessageParam[] = []
  private readonly opts: EngineOptions
  private abortController: AbortController

  constructor(opts: EngineOptions) {
    this.opts = opts
    this.abortController = opts.abortController ?? new AbortController()
  }

  getMessages(): MessageParam[] { return this.messages }
  loadMessages(history: MessageParam[]): void { this.messages = [...history] }
  abort(): void { this.abortController.abort() }
  setModel(model: string): void { this.opts.model = model }

  private toApiTools(): Tool[] {
    return this.opts.registry.list().map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: zodToJsonSchema(t.schema),
    }))
  }

  /** One turn: user text in -> model/tool cycles -> turn-done. Never throws for tool errors. */
  async runTurn(userText: string): Promise<void> {
    const { bus, client, gate, hooks, contextManager, toolContext } = this.opts
    if (this.abortController.signal.aborted) this.abortController = new AbortController()
    const signal = this.abortController.signal
    const promptHook = await hooks.run('UserPromptSubmit', { prompt: userText })
    const text = promptHook.addedContext ? `${userText}\n\n<hook-context>\n${promptHook.addedContext}\n</hook-context>` : userText
    this.push({ role: 'user', content: text })
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }

    for (;;) {
      if (signal.aborted) { bus.emit({ type: 'error', message: 'Turn aborted', fatal: false }); break }
      let result
      try {
        result = await client.stream({
          model: this.opts.model, system: this.opts.systemPrompt,
          messages: this.messages, tools: this.toApiTools(),
          maxTokens: this.opts.maxTokens, signal,
        }, {
          onTextDelta: (d) => bus.emit({ type: 'assistant-text', delta: d }),
          onThinkingDelta: (d) => bus.emit({ type: 'assistant-thinking', delta: d }),
        })
      } catch (err) {
        const aborted = signal.aborted
        bus.emit({ type: 'error', message: aborted ? 'Turn aborted' : `API error: ${(err as Error).message}`, fatal: !aborted })
        break
      }
      const msg = result.message
      usage = {
        inputTokens: msg.usage.input_tokens,
        outputTokens: msg.usage.output_tokens,
        cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
      }
      contextManager.update(usage)
      this.push({ role: 'assistant', content: msg.content })

      const toolUses = msg.content.filter((b): b is ToolUseBlock => b.type === 'tool_use')
      if (msg.stop_reason !== 'tool_use' || toolUses.length === 0) break

      // Parallel tool_use blocks are executed sequentially in block order (Task 12 adds the Agent-batch exception).
      const results: MessageParam['content'] = []
      let abortedMidTools = false
      for (const block of toolUses) {
        if (signal.aborted) { abortedMidTools = true; break }
        bus.emit({ type: 'tool-request', id: block.id, name: block.name, input: block.input })
        const out = await this.dispatchTool(block, signal)
        bus.emit({ type: 'tool-result', id: block.id, name: block.name, output: out.output, isError: out.isError })
        ;(results as unknown[]).push({ type: 'tool_result', tool_use_id: block.id, content: out.output, is_error: out.isError })
      }
      if (results.length > 0) this.push({ role: 'user', content: results })
      if (abortedMidTools) { bus.emit({ type: 'error', message: 'Turn aborted', fatal: false }); break }

      if (contextManager.needsCompaction()) {
        const { messages: compacted, summary } = await contextManager.compact(this.messages,
          (p) => client.complete({ model: this.opts.model, prompt: p, maxTokens: 2048 }))
        this.messages = compacted
        this.opts.onMessagesChanged?.(this.messages)
        bus.emit({ type: 'compaction', summary })
      }
    }
    await hooks.run('Stop', {})
    bus.emit({ type: 'turn-done', usage })
  }

  /** Permission gate -> PreToolUse hooks -> validate -> execute -> PostToolUse. Every failure becomes an error tool result. */
  private async dispatchTool(block: ToolUseBlock, signal: AbortSignal): Promise<ToolOutput> {
    const { gate, hooks, registry, toolContext } = this.opts
    const tool = registry.get(block.name)
    if (!tool) return { output: `Unknown tool: ${block.name}`, isError: true }

    const decision = gate.check({ toolName: block.name, input: block.input, readOnly: tool.readOnly, summary: summarize(block) })
    let allowed = decision.decision === 'allow'
    if (decision.decision === 'ask') {
      const answer = this.opts.askUser
        ? await this.opts.askUser({ toolName: block.name, input: block.input, summary: summarize(block), reason: decision.reason })
        : 'deny' as const
      if (answer === 'allow-always') { gate.grantSession(ruleFor(block)); allowed = true }
      else allowed = answer === 'allow-once'
    }
    if (!allowed) return { output: `Permission denied: ${decision.reason}`, isError: true }

    const pre = await hooks.run('PreToolUse', { toolName: block.name, input: block.input })
    if (!pre.allowed) return { output: `Blocked by PreToolUse hook: ${pre.reason ?? 'no reason given'}`, isError: true }

    const parsed = tool.schema.safeParse(block.input)
    if (!parsed.success) return { output: `Invalid input for ${block.name}: ${parsed.error.message}`, isError: true }

    let out: ToolOutput
    try {
      out = await tool.execute(parsed.data as never, { ...toolContext, abortSignal: signal })
    } catch (err) {
      out = { output: `${block.name} threw: ${(err as Error).message}`, isError: true }
    }
    await hooks.run('PostToolUse', { toolName: block.name, input: block.input, output: out.output })
    return out
  }

  private push(m: MessageParam): void {
    this.messages.push(m)
    this.opts.onMessagesChanged?.(this.messages)
  }
}

function summarize(block: ToolUseBlock): string {
  const input = JSON.stringify(block.input)
  return `${block.name}(${input.length > 120 ? input.slice(0, 120) + '…' : input})`
}

/** "Always allow" rule derived from the request: Bash gets a command-prefix rule, file tools get their path. */
function ruleFor(block: ToolUseBlock): string {
  const obj = (block.input ?? {}) as Record<string, unknown>
  if (block.name === 'Bash' || block.name === 'PowerShell') {
    const first = String(obj['command'] ?? '').trim().split(/\s+/)[0] ?? ''
    return `${block.name}(${first}:*)`
  }
  if (typeof obj['file_path'] === 'string') return `${block.name}(${String(obj['file_path']).replaceAll('\\', '/')})`
  return block.name
}

/** Minimal zod -> JSON Schema conversion for object schemas (string/number/boolean/enum/array/optional/default). */
export function zodToJsonSchema(schema: z.ZodType<unknown>): Tool['input_schema'] { /* ~40 lines: unwrap ZodDefault/ZodOptional, map ZodObject shape recursively; full implementation written in this task, unit-tested via toApiTools in loop.test.ts */ }
```

  `zodToJsonSchema` must be implemented in this task (not deferred): recurse over `schema._def`, handling `ZodObject` (properties + required from non-optional keys), `ZodString` -> `{type:'string'}`, `ZodNumber` -> `{type:'number'}`, `ZodBoolean` -> `{type:'boolean'}`, `ZodEnum` -> `{type:'string', enum}`, `ZodArray` -> `{type:'array', items}`, `ZodOptional`/`ZodDefault` -> unwrap inner and drop from `required`. Add a direct unit test asserting the Read tool schema converts to `{ type: 'object', properties: { file_path: { type: 'string' }, ... }, required: ['file_path'] }`.

- [ ] Run `pnpm test tests/engine/loop.test.ts` — all passing. `pnpm typecheck && pnpm lint`.
- [ ] Commit:

```
git add src/engine/client.ts src/engine/loop.ts src/engine/index.ts tests/helpers/mock-client.ts tests/engine/loop.test.ts
git commit -m "feat(engine): agentic turn loop with permission gate, hooks, abort, and streaming client wrapper

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 11: Session persistence

**Files:**
- Create: `src/harness/sessions.ts`
- Modify: `src/harness/index.ts`
- Test: `tests/harness/sessions.test.ts`

**Steps:**

- [ ] Write failing test `tests/harness/sessions.test.ts` (temp-dir sessions root):

```ts
it('appends messages as JSONL lines incrementally', () => {
  const store = new SessionStore(sessionsRoot, 'C:/projects/my-app')
  const session = store.create()
  session.appendMessage({ role: 'user', content: 'hello' })
  session.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'hi', citations: null }] })
  const lines = readFileSync(session.file, 'utf8').trim().split('\n')
  expect(lines).toHaveLength(2)
  expect(JSON.parse(lines[0]!)).toMatchObject({ kind: 'message', data: { role: 'user' } })
})

it('slugifies the project path deterministically', () => {
  expect(projectSlug('C:/projects/my-app')).toBe('C--projects-my-app')
})

it('list returns sessions newest first with id, timestamps, and first user text as title', () => { /* create two with distinct mtimes */ })

it('resume reconstructs Message[] exactly', () => {
  const store = new SessionStore(sessionsRoot, 'C:/p')
  const session = store.create()
  const history: MessageParam[] = [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'x' } }] as never },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'data' }] as never },
  ]
  for (const m of history) session.appendMessage(m)
  expect(store.resume(session.id)).toEqual(history)
})

it('continue picks the most recently written session', () => { /* two sessions, later write wins */ })
it('skips corrupt trailing line (crash mid-write) instead of throwing', () => { /* append raw half-line, resume still returns prior messages */ })
it('appendEvent lines are preserved but excluded from resume()', () => { /* kind: "event" ignored by resume */ })
```

- [ ] Run — expect failure.
- [ ] Write `src/harness/sessions.ts` (full):

```ts
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import type { EngineEvent } from '../engine/types.js'

export function projectSlug(projectPath: string): string {
  return projectPath.replaceAll('\\', '/').replace(/\//g, '-').replace(/[^A-Za-z0-9._-]/g, '-')
}

interface SessionLine { kind: 'message' | 'event'; ts: string; data: unknown }

export interface SessionInfo { id: string; file: string; startedAt: Date; updatedAt: Date; title: string }

export class Session {
  constructor(readonly id: string, readonly file: string) {}
  private appendLine(line: SessionLine): void {
    appendFileSync(this.file, JSON.stringify(line) + '\n', 'utf8')
  }
  appendMessage(message: MessageParam): void {
    this.appendLine({ kind: 'message', ts: new Date().toISOString(), data: message })
  }
  appendEvent(event: EngineEvent): void {
    this.appendLine({ kind: 'event', ts: new Date().toISOString(), data: event })
  }
}

export class SessionStore {
  private readonly dir: string
  constructor(sessionsRoot: string, projectPath: string) {
    this.dir = join(sessionsRoot, projectSlug(projectPath))
  }

  create(): Session {
    mkdirSync(this.dir, { recursive: true })
    const id = `${new Date().toISOString().replaceAll(':', '-').slice(0, 19)}-${randomUUID().slice(0, 8)}`
    return new Session(id, join(this.dir, `${id}.jsonl`))
  }

  private parseFile(file: string): SessionLine[] {
    const lines: SessionLine[] = []
    for (const raw of readFileSync(file, 'utf8').split('\n')) {
      if (!raw.trim()) continue
      try { lines.push(JSON.parse(raw) as SessionLine) } catch { /* torn trailing write from a crash — skip */ }
    }
    return lines
  }

  list(): SessionInfo[] {
    if (!existsSync(this.dir)) return []
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const file = join(this.dir, f)
        const stat = statSync(file)
        const firstUser = this.parseFile(file).find(
          (l) => l.kind === 'message' && (l.data as MessageParam).role === 'user'
            && typeof (l.data as MessageParam).content === 'string')
        return {
          id: f.replace(/\.jsonl$/, ''), file,
          startedAt: stat.birthtime, updatedAt: stat.mtime,
          title: firstUser ? String((firstUser.data as MessageParam).content).slice(0, 80) : '(no prompt)',
        }
      })
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
  }

  resume(id: string): MessageParam[] {
    const file = join(this.dir, `${id}.jsonl`)
    if (!existsSync(file)) throw new Error(`No session ${id} in ${this.dir}`)
    return this.parseFile(file).filter((l) => l.kind === 'message').map((l) => l.data as MessageParam)
  }

  /** Most recently updated session, or null. */
  continueLatest(): { id: string; messages: MessageParam[] } | null {
    const latest = this.list()[0]
    return latest ? { id: latest.id, messages: this.resume(latest.id) } : null
  }
}
```

- [ ] Wire persistence in the engine construction path (done for real in Task 15): `onMessagesChanged` appends the newest message; on compaction the file gets an `appendEvent({ type: 'compaction', ... })` marker and subsequent messages continue appending — `resume` rebuilds exactly what `getMessages()` held because compaction rewrote history via `loadMessages`. To keep resume-after-compaction correct, `onMessagesChanged` receives the full array; when its length is not previous+1 the store rewrites the file: implement `Session.rewrite(messages: MessageParam[])` that truncates and re-appends all messages (add a test for it).
- [ ] Run `pnpm test tests/harness/sessions.test.ts` — all passing. `pnpm typecheck && pnpm lint`.
- [ ] Commit:

```
git add src/harness/sessions.ts src/harness/index.ts tests/harness/sessions.test.ts
git commit -m "feat(harness): JSONL session persistence with list/resume/continue and crash-tolerant parsing

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 12: Sub-agents (Agent tool + orchestrator)

**Files:**
- Create: `src/harness/agents.ts`, `src/tools/agent.ts`
- Modify: `src/engine/loop.ts` (Agent-batch parallel dispatch), `src/tools/index.ts`, `src/harness/index.ts`
- Test: `tests/harness/agents.test.ts`

**Steps:**

- [ ] Write failing integration test `tests/harness/agents.test.ts` (MockAnthropicClient from Task 10):

```ts
function researcherDef(): AgentDef {
  return { name: 'researcher', description: 'read-only', tools: ['Read', 'Grep'], model: null, systemPrompt: 'You research.', file: 'x.md' }
}

it('Agent tool runs a child loop and returns its final text as the tool result', async () => {
  const childScript: ScriptedResponse[] = [{ blocks: [textBlock('child answer')], stopReason: 'end_turn' }]
  const orchestrator = new AgentOrchestrator({
    defs: [researcherDef()],
    clientFactory: () => new MockAnthropicClient(childScript),
    baseRegistry: fullRegistry(),          // includes Agent tool
    gate: allowAllGate(), hooks: new HookRunner([]),
    defaultModel: 'mock', systemPromptBase: 'sys',
  })
  const agentTool = makeAgentTool(orchestrator)
  const res = await agentTool.execute({ agent: 'researcher', prompt: 'find X' }, makeCtx(process.cwd()))
  expect(res.isError).toBe(false)
  expect(res.output).toBe('child answer')
})

it('child registry is restricted to the frontmatter tools and NEVER contains Agent (one-level nesting)', async () => {
  const orchestrator = /* as above */
  const child = orchestrator.buildChildRegistry(researcherDef())
  expect(child.list().map((t) => t.name).sort()).toEqual(['Grep', 'Read'])
  const unrestricted = orchestrator.buildChildRegistry({ ...researcherDef(), tools: null })
  expect(unrestricted.get('Agent')).toBeUndefined()
})

it('child tool calls pass through the SAME permission gate and hook runner instances', async () => {
  const checks: string[] = []
  const spyGate: PermissionGate = {
    check: (r) => { checks.push(r.toolName); return { decision: 'deny', reason: 'spy' } },
    grantSession: () => {},
  }
  const childScript: ScriptedResponse[] = [
    { blocks: [toolUseBlock('t1', 'Read', { file_path: 'x' })], stopReason: 'tool_use' },
    { blocks: [textBlock('done')], stopReason: 'end_turn' },
  ]
  /* run with gate: spyGate -> expect checks to contain 'Read' */
})

it('unknown agent name returns an error tool result, not a throw', async () => { /* isError true, lists available agents */ })

it('spawnMany runs children concurrently and preserves result order', async () => {
  /* two defs whose mock clients resolve in reverse order via controlled promises; expect [resA, resB] order */
})
```

- [ ] Run — expect failures.
- [ ] Write `src/harness/agents.ts` (full):

```ts
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import { Engine } from '../engine/loop.js'
import { EngineEventBus } from '../engine/events.js'
import { ContextManager } from '../engine/context.js'
import { ToolRegistry } from '../tools/registry.js'
import { HookRunner } from './hooks.js'
import type { ModelClient } from '../engine/client.js'
import type { AgentDef } from '../brain/loader.js'
import type { PermissionGate, ToolContext, ToolOutput } from '../engine/types.js'

export interface AgentOrchestratorOptions {
  defs: AgentDef[]
  clientFactory: () => ModelClient
  baseRegistry: ToolRegistry
  gate: PermissionGate          // SAME instance as the parent — spec section 7
  hooks: HookRunner             // SAME instance as the parent
  defaultModel: string
  systemPromptBase: string      // constitution + environment; agent systemPrompt is appended
  modelWindowTokens?: number
}

export class AgentOrchestrator {
  constructor(private readonly opts: AgentOrchestratorOptions) {}

  listDefs(): AgentDef[] { return this.opts.defs }
  getDef(name: string): AgentDef | undefined { return this.opts.defs.find((d) => d.name === name) }

  /** Restricted registry: frontmatter tools (or all), minus Agent — enforces one-level nesting. */
  buildChildRegistry(def: AgentDef): ToolRegistry {
    return this.opts.baseRegistry.restrict(def.tools, ['Agent'])
  }

  async runAgent(def: AgentDef, prompt: string, parentCtx: ToolContext): Promise<ToolOutput> {
    const bus = new EngineEventBus()
    let finalText = ''
    let fatalError: string | null = null
    bus.on((e) => {
      if (e.type === 'assistant-text') finalText += e.delta
      if (e.type === 'error' && e.fatal) fatalError = e.message
    })
    const engine = new Engine({
      client: this.opts.clientFactory(),
      bus,
      registry: this.buildChildRegistry(def),
      gate: this.opts.gate,
      hooks: this.opts.hooks,
      contextManager: new ContextManager({ modelWindowTokens: this.opts.modelWindowTokens ?? 200_000 }),
      toolContext: { ...parentCtx, todos: [], emit: (e) => bus.emit(e) },   // child gets its own todo list
      model: def.model ?? this.opts.defaultModel,
      systemPrompt: `${this.opts.systemPromptBase}\n\n---\n\n# Agent: ${def.name}\n\n${def.systemPrompt}`,
      maxTokens: 8192,
      // askUser deliberately absent: an 'ask' decision denies inside a sub-agent; only rules/mode allow.
    })
    await engine.runTurn(prompt)
    if (fatalError) return { output: `Agent ${def.name} failed: ${fatalError}`, isError: true }
    // Final text = text of the LAST assistant message (deltas across cycles are accumulated; reset per cycle):
    const last = [...engine.getMessages()].reverse().find((m) => m.role === 'assistant')
    const text = extractText(last) || finalText
    return { output: text.trim() || `(agent ${def.name} produced no text)`, isError: false }
  }

  /** Parallel spawn: used by the loop when one assistant message carries several Agent tool_use blocks. */
  spawnMany(jobs: Array<{ def: AgentDef; prompt: string }>, parentCtx: ToolContext): Promise<ToolOutput[]> {
    return Promise.all(jobs.map((j) => this.runAgent(j.def, j.prompt, parentCtx)))
  }
}

function extractText(m: MessageParam | undefined): string {
  if (!m) return ''
  if (typeof m.content === 'string') return m.content
  return m.content.filter((b): b is { type: 'text'; text: string } => (b as { type: string }).type === 'text')
    .map((b) => b.text).join('')
}
```

- [ ] Write `src/tools/agent.ts` (full):

```ts
import { z } from 'zod'
import type { ToolDefinition } from '../engine/types.js'
import type { AgentOrchestrator } from '../harness/agents.js'

const AgentInput = z.object({
  agent: z.string(),
  prompt: z.string().min(1),
})

export function makeAgentTool(orchestrator: AgentOrchestrator): ToolDefinition<z.infer<typeof AgentInput>> {
  return {
    name: 'Agent',
    description: 'Spawn a sub-agent by name with a task prompt. The sub-agent runs its own loop with a restricted tool set and returns its final report. Available agents: '
      + orchestrator.listDefs().map((d) => `${d.name} (${d.description})`).join('; '),
    schema: AgentInput,
    readOnly: false,
    async execute(input, ctx) {
      const def = orchestrator.getDef(input.agent)
      if (!def) {
        return {
          output: `Unknown agent "${input.agent}". Available: ${orchestrator.listDefs().map((d) => d.name).join(', ') || '(none defined)'}`,
          isError: true,
        }
      }
      return orchestrator.runAgent(def, input.prompt, ctx)
    },
  }
}
```

- [ ] Modify `src/engine/loop.ts` tool-dispatch section: before the sequential `for` loop over `toolUses`, add the Agent-batch fast path (parallel spawn support from spec section 7):

```ts
// Inside runTurn, replacing the plain sequential loop:
const allAgentCalls = toolUses.length > 1 && toolUses.every((b) => b.name === 'Agent')
if (allAgentCalls) {
  for (const block of toolUses) bus.emit({ type: 'tool-request', id: block.id, name: block.name, input: block.input })
  const outs = await Promise.all(toolUses.map((block) => this.dispatchTool(block, signal)))
  toolUses.forEach((block, i) => {
    const out = outs[i]!
    bus.emit({ type: 'tool-result', id: block.id, name: block.name, output: out.output, isError: out.isError })
    ;(results as unknown[]).push({ type: 'tool_result', tool_use_id: block.id, content: out.output, is_error: out.isError })
  })
} else {
  /* existing sequential for-loop unchanged */
}
```

  Add a loop test: two Agent tool_use blocks in one response dispatch concurrently (assert via interleaved timestamps recorded by a stubbed orchestrator) while mixed batches stay sequential.
- [ ] Run `pnpm test tests/harness/agents.test.ts tests/engine/loop.test.ts` — all passing. `pnpm typecheck && pnpm lint`.
- [ ] Commit:

```
git add src/harness/agents.ts src/tools/agent.ts src/engine/loop.ts src/tools/index.ts src/harness/index.ts tests/harness/agents.test.ts tests/engine/loop.test.ts
git commit -m "feat(harness): sub-agent orchestrator with restricted registries, shared gates, parallel spawn

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 13: Import command (Ares -> Athena inheritance)

**Files:**
- Create: `src/brain/import.ts`
- Modify: `src/brain/index.ts`
- Test: `tests/brain/import.test.ts` (with an in-test fixture builder)

**Steps:**

- [ ] Write failing test `tests/brain/import.test.ts`. Fixture built per-test in a temp dir:

```ts
function buildAresFixture(src: string): void {
  mkdirSync(join(src, 'memory'), { recursive: true })
  mkdirSync(join(src, 'skills', 'sop'), { recursive: true })
  mkdirSync(join(src, 'agents'), { recursive: true })
  writeFileSync(join(src, 'ARES.md'),
    '# Ares Constitution\n\nI am Ares. Ares follows rules.\n\n```bash\necho "Ares stays literal in code blocks"\n```\n\nCaresses and Aresian are not whole words.\n')
  writeFileSync(join(src, 'memory', 'MEMORY.md'), '# Memory Index\n- [fact](fact.md) — Ares learned this\n')
  writeFileSync(join(src, 'memory', 'fact.md'),
    '---\nname: Ares core fact\ndescription: How Ares handles commits\n---\nThe body mentions Ares and stays untouched outside frontmatter.\n')
  writeFileSync(join(src, 'skills', 'sop', 'SKILL.md'), '---\nname: sop\ndescription: gate\n---\nbody\n')
  writeFileSync(join(src, 'agents', 'scout.md'), '---\nname: scout\ndescription: scout\n---\nbody\n')
}

it('copies memory, skills, agents, and constitution into the target brain', async () => {
  buildAresFixture(src)
  const report = await importBrain({ sourceDir: src, paths: resolveBrainPaths({ cwd: proj, homeOverride: home }), force: false })
  expect(existsSync(join(home, '.athena', 'ATHENA.md'))).toBe(true)
  expect(existsSync(join(home, '.athena', 'memory', 'fact.md'))).toBe(true)
  expect(existsSync(join(home, '.athena', 'skills', 'sop', 'SKILL.md'))).toBe(true)
  expect(existsSync(join(home, '.athena', 'agents', 'scout.md'))).toBe(true)
  expect(report.copied.length).toBeGreaterThanOrEqual(5)
})

it('rewrites whole-word Ares->Athena in the constitution but NOT inside code blocks or partial words', async () => {
  buildAresFixture(src); await importBrain(/* ... */)
  const constitution = readFileSync(join(home, '.athena', 'ATHENA.md'), 'utf8')
  expect(constitution).toContain('I am Athena. Athena follows rules.')
  expect(constitution).toContain('echo "Ares stays literal in code blocks"')
  expect(constitution).toContain('Caresses and Aresian')
})

it('rewrites memory frontmatter name/description lines only, leaving bodies alone', async () => {
  buildAresFixture(src); await importBrain(/* ... */)
  const fact = readFileSync(join(home, '.athena', 'memory', 'fact.md'), 'utf8')
  expect(fact).toContain('name: Athena core fact')
  expect(fact).toContain('description: How Athena handles commits')
  expect(fact).toContain('The body mentions Ares and stays untouched')
})

it('writes an import report listing copied, rewritten, and flagged files', async () => {
  buildAresFixture(src)
  const report = await importBrain(/* ... */)
  const reportFile = join(home, '.athena', 'import-report.md')
  expect(existsSync(reportFile)).toBe(true)
  expect(report.rewritten).toContain('ATHENA.md')
  expect(report.flagged.some((f) => f.file === 'memory/fact.md')).toBe(true)   // body still mentions Ares -> manual review
})

it('refuses when target memory is non-empty unless force', async () => {
  buildAresFixture(src)
  mkdirSync(join(home, '.athena', 'memory'), { recursive: true })
  writeFileSync(join(home, '.athena', 'memory', 'existing.md'), 'x')
  await expect(importBrain({ sourceDir: src, paths, force: false })).rejects.toThrow(/non-empty/)
  await expect(importBrain({ sourceDir: src, paths, force: true })).resolves.toBeTruthy()
})
```

- [ ] Run — expect failure.
- [ ] Write `src/brain/import.ts` (full — the rewriter is the load-bearing logic):

```ts
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { BrainPaths } from './paths.js'

export interface ImportReport {
  copied: string[]
  rewritten: string[]
  flagged: Array<{ file: string; reason: string }>
}

/** Whole-word Ares->Athena outside fenced code blocks. frontmatterOnly limits rewriting to name:/description: lines of the leading frontmatter. */
export function rewriteIdentity(content: string, opts: { frontmatterOnly: boolean }): { text: string; changed: boolean } {
  const lines = content.split('\n')
  let inCodeBlock = false
  let inFrontmatter = false
  let frontmatterClosed = false
  let changed = false
  const out = lines.map((line, i) => {
    if (i === 0 && line.trim() === '---') { inFrontmatter = true; return line }
    if (inFrontmatter && !frontmatterClosed && line.trim() === '---') { frontmatterClosed = true; inFrontmatter = false; return line }
    if (/^\s*(```|~~~)/.test(line)) { inCodeBlock = !inCodeBlock; return line }
    if (inCodeBlock) return line
    if (opts.frontmatterOnly) {
      const isTargetLine = inFrontmatter && /^(name|description):/i.test(line.trim())
      if (!isTargetLine) return line
    }
    const next = line.replace(/\bAres\b/g, 'Athena').replace(/\bARES\b/g, 'ATHENA').replace(/\bares\b/g, 'athena')
    if (next !== line) changed = true
    return next
  })
  return { text: out.join('\n'), changed }
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir)) {
    const full = join(dir, e)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

const SOURCE_CONSTITUTION_NAMES = ['ARES.md', 'CONSTITUTION.md', 'ATHENA.md', 'CLAUDE.md']

export async function importBrain(opts: { sourceDir: string; paths: BrainPaths; force: boolean }): Promise<ImportReport> {
  const { sourceDir, paths, force } = opts
  if (!existsSync(sourceDir)) throw new Error(`Source directory not found: ${sourceDir}`)
  const targetMemoryFiles = existsSync(paths.memoryDir) ? walk(paths.memoryDir) : []
  if (targetMemoryFiles.length > 0 && !force) {
    throw new Error(`Target memory is non-empty (${targetMemoryFiles.length} files in ${paths.memoryDir}). Re-run with --force to merge/overwrite.`)
  }
  const report: ImportReport = { copied: [], rewritten: [], flagged: [] }

  // 1. Constitution: first matching source name, rewritten fully, written as ATHENA.md.
  const constitutionSource = SOURCE_CONSTITUTION_NAMES.map((n) => join(sourceDir, n)).find(existsSync)
  if (constitutionSource) {
    const { text, changed } = rewriteIdentity(readFileSync(constitutionSource, 'utf8'), { frontmatterOnly: false })
    mkdirSync(paths.brainDir, { recursive: true })
    writeFileSync(paths.constitutionFile, text, 'utf8')
    report.copied.push('ATHENA.md')
    if (changed) report.rewritten.push('ATHENA.md')
  } else {
    report.flagged.push({ file: '(constitution)', reason: `No constitution found in ${sourceDir} (looked for ${SOURCE_CONSTITUTION_NAMES.join(', ')})` })
  }

  // 2. memory/ — frontmatter-only rewrite; bodies still mentioning Ares get flagged for manual review.
  //    skills/ and agents/ — copied verbatim (no rewrite), flagged if they mention Ares.
  const sections: Array<{ name: string; targetDir: string; rewrite: boolean }> = [
    { name: 'memory', targetDir: paths.memoryDir, rewrite: true },
    { name: 'skills', targetDir: paths.skillsDir, rewrite: false },
    { name: 'agents', targetDir: paths.agentsDir, rewrite: false },
  ]
  for (const section of sections) {
    const srcDir = join(sourceDir, section.name)
    if (!existsSync(srcDir)) continue
    for (const file of walk(srcDir)) {
      const rel = `${section.name}/${relative(srcDir, file).replaceAll('\\', '/')}`
      const dest = join(section.targetDir, relative(srcDir, file))
      mkdirSync(join(dest, '..'), { recursive: true })
      let content = readFileSync(file, 'utf8')
      if (section.rewrite && file.endsWith('.md')) {
        const { text, changed } = rewriteIdentity(content, { frontmatterOnly: true })
        content = text
        if (changed) report.rewritten.push(rel)
      }
      writeFileSync(dest, content, 'utf8')
      report.copied.push(rel)
      if (/\bAres\b/i.test(content)) report.flagged.push({ file: rel, reason: 'still mentions Ares outside rewritten regions — review manually' })
    }
  }

  // 3. Report file.
  const reportMd = [
    '# Athena Import Report', '', `Source: ${sourceDir}`, `Date: ${new Date().toISOString()}`, '',
    `## Copied (${report.copied.length})`, ...report.copied.map((f) => `- ${f}`), '',
    `## Rewritten (${report.rewritten.length})`, ...report.rewritten.map((f) => `- ${f}`), '',
    `## Flagged for manual review (${report.flagged.length})`,
    ...report.flagged.map((f) => `- ${f.file} — ${f.reason}`), '',
  ].join('\n')
  writeFileSync(join(paths.brainDir, 'import-report.md'), reportMd, 'utf8')
  return report
}
```

  Note `cpSync` import is unused after the per-file walk approach — drop it during implementation (lint enforces).
- [ ] Run `pnpm test tests/brain/import.test.ts` — all passing. `pnpm typecheck && pnpm lint`.
- [ ] Commit:

```
git add src/brain/import.ts src/brain/index.ts tests/brain/import.test.ts
git commit -m "feat(brain): one-time Ares import with code-block-aware identity rewrite and report

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 14: TUI (Ink)

**Files:**
- Create: `src/tui/App.tsx`, `src/tui/components/Transcript.tsx`, `src/tui/components/ToolCard.tsx`, `src/tui/components/DiffPreview.tsx`, `src/tui/components/PermissionDialog.tsx`, `src/tui/components/StatusLine.tsx`, `src/tui/components/TodoPanel.tsx`, `src/tui/components/InputBox.tsx`, `src/tui/slash.ts`
- Modify: `src/tui/index.ts`, `tsup.config.ts` (no change needed — App is imported by cli.ts; verify .tsx builds), `package.json` only if a missing @types surfaces
- Test: `tests/tui/app.test.tsx`, `tests/tui/slash.test.ts`

**Steps:**

- [ ] Write failing test `tests/tui/slash.test.ts` for the pure slash-command parser (testable without Ink):

```ts
it.each([
  ['/help', { kind: 'help' }],
  ['/clear', { kind: 'clear' }],
  ['/resume', { kind: 'resume' }],
  ['/compact', { kind: 'compact' }],
  ['/model claude-opus-4-6', { kind: 'model', value: 'claude-opus-4-6' }],
  ['/mode plan', { kind: 'mode', value: 'plan' }],
  ['/memory', { kind: 'memory' }],
  ['/skills', { kind: 'skills' }],
  ['/agents', { kind: 'agents' }],
  ['/quit', { kind: 'quit' }],
  ['not a command', null],
  ['/mode yolo', { kind: 'error', value: 'Unknown mode: yolo' }],
  ['/bogus', { kind: 'error', value: 'Unknown command: /bogus' }],
] as const)('parseSlash(%s)', (input, expected) => {
  expect(parseSlash(input)).toEqual(expected)
})
```

- [ ] Write failing smoke tests `tests/tui/app.test.tsx` with ink-testing-library:

```tsx
import { render } from 'ink-testing-library'
import { App } from '../../src/tui/App.js'

function makeHarness() {
  const bus = new EngineEventBus()
  return {
    bus,
    props: {
      bus,
      status: { cwd: 'C:/proj', gitBranch: 'main', model: 'mock', mode: 'normal' as const, contextPct: 12 },
      onSubmit: vi.fn(async () => {}),
      onSlash: vi.fn(),
      onAbort: vi.fn(),
      permissionBridge: new PermissionBridge(),
    },
  }
}

it('renders the status line and input box', () => {
  const { props } = makeHarness()
  const { lastFrame } = render(<App {...props} />)
  expect(lastFrame()).toContain('C:/proj')
  expect(lastFrame()).toContain('main')
  expect(lastFrame()).toContain('normal')
})

it('streams assistant text from engine events into the transcript', async () => {
  const { bus, props } = makeHarness()
  const { lastFrame } = render(<App {...props} />)
  bus.emit({ type: 'assistant-text', delta: 'Hello from Athena' })
  await delay(10)
  expect(lastFrame()).toContain('Hello from Athena')
})

it('permission dialog renders on request and answers flow back', async () => {
  const { props } = makeHarness()
  const { lastFrame, stdin } = render(<App {...props} />)
  const answer = props.permissionBridge.ask({ toolName: 'Bash', input: { command: 'git push' }, summary: 'Bash(git push)', reason: 'mutating' })
  await delay(10)
  expect(lastFrame()).toContain('git push')
  expect(lastFrame()).toMatch(/allow once/i)
  stdin.write('y')                     // 'y' = allow once
  await expect(answer).resolves.toBe('allow-once')
})

it('todo-update event renders the checklist panel', async () => {
  const { bus, props } = makeHarness()
  const { lastFrame } = render(<App {...props} />)
  bus.emit({ type: 'todo-update', todos: [{ text: 'write tests', status: 'in_progress' }] })
  await delay(10)
  expect(lastFrame()).toContain('write tests')
})
```

- [ ] Run — expect failures.
- [ ] Write `src/tui/slash.ts` (full):

```ts
import type { PermissionMode } from '../engine/types.js'

export type SlashCommand =
  | { kind: 'help' } | { kind: 'clear' } | { kind: 'resume' } | { kind: 'compact' }
  | { kind: 'memory' } | { kind: 'skills' } | { kind: 'agents' } | { kind: 'quit' }
  | { kind: 'model'; value: string }
  | { kind: 'mode'; value: PermissionMode }
  | { kind: 'error'; value: string }

const MODES = new Set(['normal', 'acceptEdits', 'plan', 'trusted'])
const BARE = new Set(['help', 'clear', 'resume', 'compact', 'memory', 'skills', 'agents', 'quit'])

export function parseSlash(input: string): SlashCommand | null {
  if (!input.startsWith('/')) return null
  const [cmd = '', ...rest] = input.slice(1).trim().split(/\s+/)
  const arg = rest.join(' ')
  if (BARE.has(cmd)) return { kind: cmd } as SlashCommand
  if (cmd === 'model') return arg ? { kind: 'model', value: arg } : { kind: 'error', value: 'Usage: /model <model-id>' }
  if (cmd === 'mode') {
    if (!MODES.has(arg)) return { kind: 'error', value: `Unknown mode: ${arg || '(none)'}` }
    return { kind: 'mode', value: arg as PermissionMode }
  }
  return { kind: 'error', value: `Unknown command: /${cmd}` }
}
```

- [ ] Write `src/tui/components/PermissionDialog.tsx` and its `PermissionBridge` (full — this is how engine `askUser` reaches React):

```tsx
// PermissionBridge lives in src/tui/App.tsx module scope or its own file section:
export type PermissionAnswer = 'allow-once' | 'allow-always' | 'deny'
export interface PendingPermission {
  toolName: string; input: unknown; summary: string; reason: string
  resolve: (a: PermissionAnswer) => void
}

export class PermissionBridge {
  private setter: ((p: PendingPermission | null) => void) | null = null
  bind(setter: (p: PendingPermission | null) => void): void { this.setter = setter }
  /** Passed to Engine as askUser. */
  ask(req: { toolName: string; input: unknown; summary: string; reason: string }): Promise<PermissionAnswer> {
    return new Promise((resolve) => {
      const pending: PendingPermission = { ...req, resolve: (a) => { this.setter?.(null); resolve(a) } }
      if (this.setter) this.setter(pending)
      else resolve('deny')   // headless: fail safe
    })
  }
}

// src/tui/components/PermissionDialog.tsx
import { Box, Text, useInput } from 'ink'
import type { PendingPermission } from '../App.js'

export function PermissionDialog({ pending }: { pending: PendingPermission }) {
  useInput((ch) => {
    if (ch === 'y') pending.resolve('allow-once')
    else if (ch === 'a') pending.resolve('allow-always')
    else if (ch === 'n') pending.resolve('deny')
  })
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">Permission required</Text>
      <Text>{pending.summary}</Text>
      <Text dimColor>{pending.reason}</Text>
      <Text>[y] allow once   [a] always allow (writes rule)   [n] deny</Text>
    </Box>
  )
}
```

- [ ] Write `src/tui/App.tsx`. Full wiring skeleton (state + event subscription is the load-bearing logic; per-component rendering listed below):

```tsx
import { useEffect, useState, useCallback } from 'react'
import { Box, useApp, useInput } from 'ink'
import type { EngineEventBus } from '../engine/events.js'
import type { EngineEvent, TodoItem, PermissionMode } from '../engine/types.js'
import { Transcript, type TranscriptEntry } from './components/Transcript.js'
import { ToolCard } from './components/ToolCard.js'
import { PermissionDialog } from './components/PermissionDialog.js'
import { StatusLine } from './components/StatusLine.js'
import { TodoPanel } from './components/TodoPanel.js'
import { InputBox } from './components/InputBox.js'
import { parseSlash, type SlashCommand } from './slash.js'

export interface AppStatus { cwd: string; gitBranch: string | null; model: string; mode: PermissionMode; contextPct: number }
export interface AppProps {
  bus: EngineEventBus
  status: AppStatus
  onSubmit: (text: string) => Promise<void>
  onSlash: (cmd: SlashCommand) => void
  onAbort: () => void
  permissionBridge: PermissionBridge
}

export function App({ bus, status, onSubmit, onSlash, onAbort, permissionBridge }: AppProps) {
  const [entries, setEntries] = useState<TranscriptEntry[]>([])
  const [todos, setTodos] = useState<TodoItem[]>([])
  const [pending, setPending] = useState<PendingPermission | null>(null)
  const [busy, setBusy] = useState(false)
  const { exit } = useApp()

  useEffect(() => { permissionBridge.bind(setPending) }, [permissionBridge])

  useEffect(() => bus.on((e: EngineEvent) => {
    setEntries((prev) => reduceEvent(prev, e))       // pure reducer, unit-testable
    if (e.type === 'todo-update') setTodos(e.todos)
    if (e.type === 'turn-done' || (e.type === 'error' && e.fatal)) setBusy(false)
  }), [bus])

  useInput((_ch, key) => { if (key.escape && busy) onAbort() })

  const handleSubmit = useCallback(async (text: string) => {
    const slash = parseSlash(text)
    if (slash) {
      if (slash.kind === 'quit') exit()
      else if (slash.kind === 'clear') setEntries([])
      else onSlash(slash)
      return
    }
    setEntries((prev) => [...prev, { kind: 'user', text }])
    setBusy(true)
    await onSubmit(text)
  }, [onSubmit, onSlash, exit])

  return (
    <Box flexDirection="column">
      <Transcript entries={entries} />
      {todos.length > 0 && <TodoPanel todos={todos} />}
      {pending && <PermissionDialog pending={pending} />}
      <InputBox onSubmit={handleSubmit} disabled={pending !== null} />
      <StatusLine {...status} busy={busy} />
    </Box>
  )
}

/** Pure event -> transcript reducer: appends/extends assistant text, opens/closes tool cards. */
export function reduceEvent(prev: TranscriptEntry[], e: EngineEvent): TranscriptEntry[] {
  switch (e.type) {
    case 'assistant-text': {
      const last = prev.at(-1)
      if (last?.kind === 'assistant') return [...prev.slice(0, -1), { ...last, text: last.text + e.delta }]
      return [...prev, { kind: 'assistant', text: e.delta }]
    }
    case 'tool-request':
      return [...prev, { kind: 'tool', id: e.id, name: e.name, input: e.input, output: null, isError: false }]
    case 'tool-result':
      return prev.map((entry) => entry.kind === 'tool' && entry.id === e.id
        ? { ...entry, output: e.output, isError: e.isError } : entry)
    case 'compaction':
      return [...prev, { kind: 'system', text: `Context compacted. ${e.summary.slice(0, 200)}` }]
    case 'error':
      return [...prev, { kind: 'system', text: `Error: ${e.message}` }]
    default:
      return prev
  }
}
```

- [ ] Write the remaining components. Complete exported signatures; rendering bodies follow the descriptions exactly:

```tsx
// Transcript.tsx
export type TranscriptEntry =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'system'; text: string }
  | { kind: 'tool'; id: string; name: string; input: unknown; output: string | null; isError: boolean }
export function Transcript({ entries }: { entries: TranscriptEntry[] }): JSX.Element
// user lines prefixed "> " cyan; assistant text rendered with lightweight markdown degradation
// (bold headings, dim code fences — plain Text, no external md lib); tool entries delegate to <ToolCard/>.

// ToolCard.tsx
export function ToolCard({ name, input, output, isError, expanded }: {
  name: string; input: unknown; output: string | null; isError: boolean; expanded?: boolean
}): JSX.Element
// Collapsed: one line "⚙ Name(inputSummary) → firstLineOfOutput" (green/red by isError, spinner while output === null).
// Expanded: bordered box with full input JSON and output. Write/Edit inputs render <DiffPreview/> instead of raw JSON.

// DiffPreview.tsx
export function DiffPreview({ oldText, newText }: { oldText: string; newText: string }): JSX.Element
// Line-based LCS diff (implement diffLines(old, new): Array<{tag:'+'|'-'|' '; line:string}> ~30 lines, unit-tested);
// '-' lines red, '+' lines green, context dim; cap at 40 lines with "(diff truncated)".
export function diffLines(oldText: string, newText: string): Array<{ tag: '+' | '-' | ' '; line: string }>

// StatusLine.tsx
export function StatusLine(props: AppStatus & { busy: boolean }): JSX.Element
// One dim line: "cwd · ⎇ branch · model · mode · ctx NN% · (esc to interrupt)" — mode colored (plan=blue, trusted=red).

// TodoPanel.tsx
export function TodoPanel({ todos }: { todos: TodoItem[] }): JSX.Element
// Checklist: done "[x]" strikethrough dim, in_progress "[~]" yellow bold, pending "[ ]".

// InputBox.tsx
export function InputBox({ onSubmit, disabled }: { onSubmit: (text: string) => void; disabled: boolean }): JSX.Element
// useInput-driven line editor: printable chars append; Enter submits (Shift+Enter/backslash-continuation appends "\n"
// for multiline); Backspace deletes; Up/Down walk a history array of past submissions; ignores input while disabled.
```

- [ ] Run `pnpm test tests/tui` — all passing. Run `pnpm typecheck && pnpm lint && pnpm build` (first .tsx through tsup — fix any jsx config fallout now, not in Task 15).
- [ ] Commit:

```
git add src/tui/App.tsx src/tui/slash.ts src/tui/components/Transcript.tsx src/tui/components/ToolCard.tsx src/tui/components/DiffPreview.tsx src/tui/components/PermissionDialog.tsx src/tui/components/StatusLine.tsx src/tui/components/TodoPanel.tsx src/tui/components/InputBox.tsx src/tui/index.ts tests/tui/app.test.tsx tests/tui/slash.test.ts
git commit -m "feat(tui): Ink app with transcript, tool cards, diff preview, permission dialog, todo panel, slash commands

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 15: CLI entry + end-to-end

**Files:**
- Create: `src/cli.ts` (replace stub), `src/harness/bootstrap.ts`, `README.md`
- Modify: `src/harness/index.ts`
- Test: `tests/cli/bootstrap.test.ts`

**Steps:**

- [ ] Write failing test `tests/cli/bootstrap.test.ts`:

```ts
it('first run scaffolds the ~/.athena skeleton with a default ATHENA.md and settings.json', () => {
  const paths = resolveBrainPaths({ cwd: proj, homeOverride: home })
  ensureBrainScaffold(paths)
  for (const dir of [paths.memoryDir, paths.skillsDir, paths.agentsDir, paths.hooksDir, paths.sessionsDir, paths.journalDir]) {
    expect(existsSync(dir)).toBe(true)
  }
  expect(readFileSync(paths.constitutionFile, 'utf8')).toContain('# Athena')
  expect(JSON.parse(readFileSync(paths.settingsFile, 'utf8'))).toMatchObject({ permissionMode: 'normal' })
})

it('scaffold never overwrites an existing constitution or settings', () => {
  /* pre-write custom ATHENA.md -> ensureBrainScaffold -> content unchanged */
})

it('parseArgs handles default run, --resume, --continue, and import <path>', () => {
  expect(parseArgs([])).toEqual({ command: 'run' })
  expect(parseArgs(['--resume'])).toEqual({ command: 'resume' })
  expect(parseArgs(['--continue'])).toEqual({ command: 'continue' })
  expect(parseArgs(['import', 'C:/old/ares', '--force'])).toEqual({ command: 'import', sourceDir: 'C:/old/ares', force: true })
  expect(parseArgs(['import'])).toEqual({ command: 'error', message: 'Usage: athena import <path> [--force]' })
})
```

- [ ] Run — expect failure.
- [ ] Write `src/harness/bootstrap.ts` (full):

```ts
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import type { BrainPaths } from '../brain/paths.js'

const DEFAULT_CONSTITUTION = `# Athena

I am Athena, a terminal coding agent. This file is my constitution: identity first, then standing rules.

## Identity
- I work inside the user's repositories with their tools and their conventions.
- I am concise, evidence-driven, and I never fabricate command output.

## Standing rules
1. Read before editing. Never overwrite a file I have not read this session.
2. Prefer the smallest correct change.
3. Run the project's own gates (typecheck, lint, tests) before declaring work done.
`

const DEFAULT_SETTINGS = {
  model: 'claude-sonnet-4-5',
  permissionMode: 'normal',
  allow: [],
  deny: [],
  hooks: [],
}

export function ensureBrainScaffold(paths: BrainPaths): void {
  for (const dir of [paths.brainDir, paths.memoryDir, paths.skillsDir, paths.agentsDir, paths.hooksDir, paths.sessionsDir, paths.journalDir]) {
    mkdirSync(dir, { recursive: true })
  }
  if (!existsSync(paths.constitutionFile)) writeFileSync(paths.constitutionFile, DEFAULT_CONSTITUTION, 'utf8')
  if (!existsSync(paths.settingsFile)) writeFileSync(paths.settingsFile, JSON.stringify(DEFAULT_SETTINGS, null, 2) + '\n', 'utf8')
  if (!existsSync(paths.memoryIndexFile)) writeFileSync(paths.memoryIndexFile, '# Memory Index\n', 'utf8')
}
```

- [ ] Replace `src/cli.ts`. Full composition root:

```ts
import { execSync } from 'node:child_process'
import { render } from 'ink'
import React from 'react'
import { resolveBrainPaths } from './brain/paths.js'
import { loadSettings } from './brain/settings.js'
import { loadConstitution, loadMemoryIndex, loadSkillsIndex, loadAgentsIndex } from './brain/loader.js'
import { importBrain } from './brain/import.js'
import { ensureBrainScaffold } from './harness/bootstrap.js'
import { PermissionEngine } from './harness/permissions.js'
import { HookRunner } from './harness/hooks.js'
import { SessionStore } from './harness/sessions.js'
import { AgentOrchestrator } from './harness/agents.js'
import { Engine } from './engine/loop.js'
import { AnthropicClient } from './engine/client.js'
import { EngineEventBus } from './engine/events.js'
import { ContextManager } from './engine/context.js'
import { assembleSystemPrompt, findProjectContextFiles } from './engine/prompt.js'
import { ToolRegistry } from './tools/registry.js'
import { readTool, writeTool, editTool, globTool, grepTool, bashTool, powershellTool, todoTool, memoryTool, webfetchTool, websearchTool } from './tools/index.js'
import { makeAgentTool } from './tools/agent.js'
import { App, PermissionBridge } from './tui/App.js'
import { parseSlash } from './tui/slash.js'

export type CliCommand =
  | { command: 'run' } | { command: 'resume' } | { command: 'continue' }
  | { command: 'import'; sourceDir: string; force: boolean }
  | { command: 'error'; message: string }

export function parseArgs(argv: string[]): CliCommand {
  if (argv[0] === 'import') {
    const sourceDir = argv[1]
    if (!sourceDir || sourceDir.startsWith('--')) return { command: 'error', message: 'Usage: athena import <path> [--force]' }
    return { command: 'import', sourceDir, force: argv.includes('--force') }
  }
  if (argv.includes('--resume')) return { command: 'resume' }
  if (argv.includes('--continue')) return { command: 'continue' }
  return { command: 'run' }
}

function gitBranch(cwd: string): string | null {
  try { return execSync('git rev-parse --abbrev-ref HEAD', { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() }
  catch { return null }
}

async function main(): Promise<void> {
  const cwd = process.cwd()
  const paths = resolveBrainPaths({ cwd })
  ensureBrainScaffold(paths)
  const cmd = parseArgs(process.argv.slice(2))

  if (cmd.command === 'error') { console.error(cmd.message); process.exitCode = 1; return }
  if (cmd.command === 'import') {
    const report = await importBrain({ sourceDir: cmd.sourceDir, paths, force: cmd.force })
    console.log(`Imported ${report.copied.length} files (${report.rewritten.length} rewritten, ${report.flagged.length} flagged).`)
    console.log(`Report: ${paths.brainDir}/import-report.md`)
    return
  }

  const settings = loadSettings(paths)
  const gate = new PermissionEngine({ mode: settings.permissionMode, allow: settings.allow, deny: settings.deny })
  const hooks = new HookRunner(settings.hooks)
  const bus = new EngineEventBus()
  const store = new SessionStore(paths.sessionsDir, cwd)

  const registry = new ToolRegistry()
  for (const t of [readTool, writeTool, editTool, globTool, grepTool, bashTool, powershellTool, todoTool, memoryTool, webfetchTool, websearchTool]) {
    registry.register(t as never)
  }
  const systemPrompt = assembleSystemPrompt({
    constitution: loadConstitution(paths),
    memoryIndex: loadMemoryIndex(paths),
    projectContext: findProjectContextFiles(cwd),
    toolGuidance: 'Use Read before Write/Edit. Prefer Grep/Glob over shell find. Keep tool outputs focused.',
    environment: { cwd, platform: process.platform, gitBranch: gitBranch(cwd), date: new Date().toISOString().slice(0, 10) },
  })
  const client = new AnthropicClient(process.env['ANTHROPIC_API_KEY'])
  const orchestrator = new AgentOrchestrator({
    defs: loadAgentsIndex(paths), clientFactory: () => client,
    baseRegistry: registry, gate, hooks,
    defaultModel: settings.model, systemPromptBase: systemPrompt,
  })
  registry.register(makeAgentTool(orchestrator) as never)

  const bridge = new PermissionBridge()
  const session = cmd.command === 'continue' ? null : store.create()   // continue reuses; resume picks below
  /* --resume: render a session picker list (store.list()) via a small Ink SelectList before mounting App;
     --continue: store.continueLatest(), engine.loadMessages(existing). Both fall back to a fresh session when none exist. */

  const contextManager = new ContextManager({ modelWindowTokens: 200_000 })
  const engine = new Engine({
    client, bus, registry, gate, hooks, contextManager,
    toolContext: {
      cwd, brainDir: paths.brainDir, projectBrainDir: paths.projectBrainDir,
      fileReadRegistry: new Set(), todos: [], emit: (e) => bus.emit(e),
      abortSignal: new AbortController().signal,
    },
    model: settings.model, systemPrompt, maxTokens: 8192,
    askUser: (req) => bridge.ask(req),
    onMessagesChanged: (messages) => session?.rewriteOrAppend(messages),
  })
  await hooks.run('SessionStart', { cwd })

  render(React.createElement(App, {
    bus,
    status: { cwd, gitBranch: gitBranch(cwd), model: settings.model, mode: gate.getMode(), contextPct: Math.round(contextManager.usedFraction() * 100) },
    onSubmit: (text) => engine.runTurn(text),
    onAbort: () => engine.abort(),
    permissionBridge: bridge,
    onSlash: (slash) => {
      /* mode -> gate.setMode; model -> engine.setModel; compact -> contextManager.compact via engine helper;
         memory/skills/agents -> emit a system transcript entry listing loadMemoryIndex/loadSkillsIndex/loadAgentsIndex;
         help -> emit command list; resume -> print sessions (full picker is the run-mode --resume path). */
    },
  }))
}

void main()
```

  The slash-handler and `--resume` picker bodies are written in this task (they compose already-built pieces; no new algorithms). `Session.rewriteOrAppend` is the Task 11 method pair (`appendMessage`/`rewrite`) behind one call: append when `messages.length === lastLength + 1`, else rewrite.
- [ ] Write `README.md`:

```md
# Athena

A standalone terminal coding agent: own agentic loop on the Anthropic SDK, Ink TUI,
permission engine, scriptable hooks, sub-agents, and a file-based brain in `~/.athena`.

## Quickstart

    pnpm install
    pnpm build
    npm link          # puts `athena` on PATH
    set ANTHROPIC_API_KEY=sk-ant-...
    cd path/to/your/project
    athena

First run scaffolds `~/.athena` (constitution, settings, memory, skills, agents, hooks, sessions).

## Commands

    athena                 # new session in the current project
    athena --continue      # resume the most recent session here
    athena --resume        # pick a past session
    athena import <path>   # one-time import of an ares-style brain (--force to merge)

In-session: `/help /clear /resume /compact /model /mode /memory /skills /agents /quit`. Esc interrupts a turn.

## Configuration

`~/.athena/settings.json` (global) overlaid by `.athena/settings.json` (per project):
model, permissionMode (`normal | acceptEdits | plan | trusted`), allow/deny rules like
`"Bash(git:*)"` or `"Edit(src/**)"`, and hooks (`SessionStart | UserPromptSubmit | PreToolUse | PostToolUse | Stop`).

## Development

    pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

- [ ] Manual end-to-end check: `pnpm build && node bin/athena.js` in a scratch project — send one prompt that triggers a Read and a Write, confirm the permission dialog appears, allow, confirm the diff renders and `/quit` exits. Verify the session JSONL landed under `~/.athena/sessions/`.
- [ ] Full gate run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build` — all green.
- [ ] Commit:

```
git add src/cli.ts src/harness/bootstrap.ts src/harness/index.ts src/harness/sessions.ts README.md tests/cli/bootstrap.test.ts
git commit -m "feat(cli): athena entry with first-run brain scaffold, resume/continue, import, full wiring

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
