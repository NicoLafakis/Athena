import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render } from 'ink-testing-library'
import { InputBox } from '../../src/tui/components/InputBox.js'
import type { AgentMentionSource } from '../../src/tui/agentMention.js'

const DOWN = '[B'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Alphabetical order matters for these assertions: researcher < reviewer (agents),
// alpha.ts < beta.ts (files) — both rankings sort alphabetically on an empty query.
const agents: AgentMentionSource[] = [
  { name: 'researcher', description: 'Read-only research and codebase exploration' },
  { name: 'reviewer', description: 'Reviews diffs for correctness and style' },
]

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'athena-inputbox-agent-mention-'))
  writeFileSync(join(dir, 'alpha.ts'), 'export const alpha = 1', 'utf8')
  writeFileSync(join(dir, 'beta.ts'), 'export const beta = 2', 'utf8')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('InputBox unified @ picker (files + agents)', () => {
  it('typing @ lists both agents and files, each visually tagged by kind', async () => {
    const onSubmit = vi.fn()
    const { lastFrame, stdin } = render(
      <InputBox onSubmit={onSubmit} disabled={false} cwd={dir} agents={agents} />,
    )
    await delay(50) // let the background file walk resolve
    stdin.write('@')
    await delay(10)
    const frame = lastFrame()!
    expect(frame).toContain('[agent] researcher')
    expect(frame).toContain('Read-only research and codebase exploration')
    expect(frame).toContain('[agent] reviewer')
    expect(frame).toContain('[file] alpha.ts')
    expect(frame).toContain('[file] beta.ts')
  })

  it('agent rows appear immediately even before the file walk resolves', async () => {
    const onSubmit = vi.fn()
    const { lastFrame, stdin } = render(
      <InputBox onSubmit={onSubmit} disabled={false} cwd={dir} agents={agents} />,
    )
    await delay(0) // let React flush useEffect so the useInput listener is mounted
    // No further delay: the file walk is still in flight, but agent matches don't
    // depend on it, so they must appear even this early.
    stdin.write('@')
    await delay(5)
    expect(lastFrame()).toContain('[agent] researcher')
  })

  it('selecting the first (agent) row via Tab inserts @agent-name, and submitting ' +
    'produces a labeled agent-guidance block referencing the Agent tool', async () => {
    const onSubmit = vi.fn()
    const { lastFrame, stdin } = render(
      <InputBox onSubmit={onSubmit} disabled={false} cwd={dir} agents={agents} />,
    )
    await delay(50)
    stdin.write('@')
    await delay(10)
    // Empty-query ranking groups agents first: index 0 is the 'researcher' agent row.
    expect(lastFrame()).toContain('[agent] researcher')
    stdin.write('\t') // Tab confirms the highlighted (agent) entry
    await delay(10)
    // (lastFrame() trims trailing whitespace per line, so the confirming assertion
    // here is on content only — the trailing space in the spliced text is verified
    // via the submitted text below instead.)
    expect(lastFrame()).toContain('@researcher')
    stdin.write('please look into this')
    await delay(10)
    stdin.write('\r')
    await delay(10)
    expect(onSubmit).toHaveBeenCalledTimes(1)
    const submitted = onSubmit.mock.calls[0]![0] as string
    expect(submitted).toContain('@researcher please look into this')
    expect(submitted).toContain('Read-only research and codebase exploration')
    expect(submitted).toContain('Agent tool')
    expect(submitted).toContain('agent: "researcher"')
    // No file content leaked in — this message never referenced a file.
    expect(submitted).not.toContain('export const alpha')
  })

  it('an agent mention and a file mention in the same message each produce their own ' +
    'block, additively', async () => {
    const onSubmit = vi.fn()
    const { stdin } = render(<InputBox onSubmit={onSubmit} disabled={false} cwd={dir} agents={agents} />)
    await delay(50)
    stdin.write('@')
    await delay(10)
    stdin.write('\t') // select 'researcher' (index 0)
    await delay(10)
    stdin.write('@')
    await delay(10)
    // Ranking order is [researcher, reviewer, alpha.ts, beta.ts]; two Downs from index 0
    // lands on alpha.ts (index 2).
    stdin.write(DOWN)
    await delay(5)
    stdin.write(DOWN)
    await delay(5)
    stdin.write('\t') // select 'alpha.ts'
    await delay(10)
    stdin.write('\r')
    await delay(10)
    expect(onSubmit).toHaveBeenCalledTimes(1)
    const submitted = onSubmit.mock.calls[0]![0] as string
    expect(submitted).toContain('@researcher @alpha.ts')
    // Agent block present.
    expect(submitted).toContain('Read-only research and codebase exploration')
    expect(submitted).toContain('agent: "researcher"')
    // File block present too, additively.
    expect(submitted).toContain('export const alpha = 1')
    expect(submitted).toContain('@alpha.ts')
  })

  it('a stale agent mention left over from history recall is dropped if the agent is ' +
    'no longer in the known list at submit time', async () => {
    const onSubmit = vi.fn()
    const { stdin } = render(<InputBox onSubmit={onSubmit} disabled={false} cwd={dir} agents={[]} />)
    await delay(50)
    // No agents wired at all: typed literal text still submits, but produces no
    // agent-guidance block since '@researcher' matches nothing in an empty agent list.
    stdin.write('please ask @researcher for help')
    await delay(10)
    stdin.write('\r')
    await delay(10)
    expect(onSubmit).toHaveBeenCalledWith('please ask @researcher for help')
  })
})
