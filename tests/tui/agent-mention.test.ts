import { describe, it, expect } from 'vitest'
import {
  rankAgentMatches,
  rankMentionCandidates,
  formatAgentMentionBlock,
  extractAgentMentionBlocks,
  type AgentMentionSource,
} from '../../src/tui/agentMention.js'
import { extractMentionBlocks } from '../../src/tui/fileMention.js'

const agents: AgentMentionSource[] = [
  { name: 'researcher', description: 'Read-only research and codebase exploration' },
  { name: 'reviewer', description: 'Reviews diffs for correctness and style' },
  { name: 'plugin-x:deploy', description: 'Deploys the plugin-x bundle' },
]

describe('rankAgentMatches', () => {
  it('empty query returns all agents, alphabetically sorted by name', () => {
    const result = rankAgentMatches('', agents)
    expect(result.map((a) => a.name)).toEqual(['plugin-x:deploy', 'researcher', 'reviewer'])
  })

  it('fuzzy-matches a query against the name', () => {
    const result = rankAgentMatches('research', agents)
    expect(result[0]!.name).toBe('researcher')
  })

  it('fuzzy-matches a query against the description', () => {
    const result = rankAgentMatches('correctness', agents)
    expect(result[0]!.name).toBe('reviewer')
  })

  it('respects the limit', () => {
    const result = rankAgentMatches('', agents, 2)
    expect(result).toHaveLength(2)
  })

  it('no agents returns an empty array regardless of query', () => {
    expect(rankAgentMatches('anything', [])).toEqual([])
  })

  it('no match for a nonsense query returns an empty array', () => {
    expect(rankAgentMatches('zzzznonexistentqqq', agents)).toEqual([])
  })
})

describe('rankMentionCandidates', () => {
  const files = ['src/tui/components/InputBox.tsx', 'src/tui/App.tsx', 'README.md', 'src/tools/glob.ts']

  it('groups agents first, then files, for an empty query', () => {
    const result = rankMentionCandidates('', files, agents, 10)
    const kinds = result.map((c) => c.kind)
    // All 3 agents lead, all files trail — a contiguous agents block first.
    expect(kinds.slice(0, 3)).toEqual(['agent', 'agent', 'agent'])
    expect(kinds.slice(3)).toEqual(['file', 'file', 'file', 'file'])
  })

  it('tags each candidate with its kind and carries the agent description', () => {
    const result = rankMentionCandidates('researcher', files, agents, 10)
    const agentRow = result.find((c) => c.kind === 'agent' && c.value === 'researcher')
    expect(agentRow?.description).toBe('Read-only research and codebase exploration')
    // File rows never carry a description.
    const fileRow = result.find((c) => c.kind === 'file')
    expect(fileRow?.description).toBeUndefined()
  })

  it('a small limit is spent on agents first, leaving fewer/no slots for files', () => {
    const result = rankMentionCandidates('', files, agents, 2)
    expect(result).toHaveLength(2)
    expect(result.every((c) => c.kind === 'agent')).toBe(true)
  })

  it('with no agents at all, behaves exactly like a file-only ranking', () => {
    const result = rankMentionCandidates('', files, [], 3)
    expect(result.map((c) => c.value)).toEqual(['README.md', 'src/tools/glob.ts', 'src/tui/App.tsx'])
    expect(result.every((c) => c.kind === 'file')).toBe(true)
  })
})

describe('formatAgentMentionBlock', () => {
  it('labels the block with the agent name, description, and Agent-tool guidance', () => {
    const block = formatAgentMentionBlock(agents[0]!)
    expect(block).toContain('@researcher')
    expect(block).toContain('Read-only research and codebase exploration')
    expect(block).toContain('Agent tool')
    expect(block).toContain('agent: "researcher"')
  })
})

describe('extractAgentMentionBlocks', () => {
  it('produces a block for an agent mention still present in the text', () => {
    const blocks = extractAgentMentionBlocks('please have @researcher look into this', agents)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toContain('@researcher')
  })

  it('matches plugin-namespaced agent names', () => {
    const blocks = extractAgentMentionBlocks('run @plugin-x:deploy now', agents)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toContain('@plugin-x:deploy')
  })

  it('ignores a stale/removed agent mention no longer in the known agent list', () => {
    // Simulates a history-recalled or backspaced-then-retyped draft referencing an
    // agent that no longer exists in orchestrator.listDefs() by the time of submit.
    const blocks = extractAgentMentionBlocks('ask @ghost-agent about this', agents)
    expect(blocks).toEqual([])
  })

  it('returns no blocks when no agent mentions survive in the text', () => {
    expect(extractAgentMentionBlocks('just a plain message', agents)).toEqual([])
  })

  it('coexists correctly with a simultaneous file mention in the same message: each ' +
    'extractor produces only its own kind of block, and both compose additively', () => {
    const text = 'please review @src/a.ts and consider delegating to @reviewer'
    const mentionedFiles = new Map([['src/a.ts', { content: 'const a = 1', truncated: false }]])
    const fileBlocks = extractMentionBlocks(text, mentionedFiles)
    const agentBlocks = extractAgentMentionBlocks(text, agents)
    expect(fileBlocks).toHaveLength(1)
    expect(fileBlocks[0]).toContain('@src/a.ts')
    expect(fileBlocks[0]).toContain('const a = 1')
    expect(agentBlocks).toHaveLength(1)
    expect(agentBlocks[0]).toContain('@reviewer')
    expect(agentBlocks[0]).not.toContain('const a = 1')
    const combined = [...fileBlocks, ...agentBlocks]
    expect(combined).toHaveLength(2)
  })

  describe('prefix-collision regression (extractAgentMentionBlocks scans the FULL agent ' +
    'universe, not just picker-selected ones, so this collision surface is real)', () => {
    // "claude" / "claude-code-guide" mirrors a real pairing in Claude Code's own
    // subagent roster, not a contrived example.
    const roster: AgentMentionSource[] = [
      { name: 'claude', description: 'General assistant' },
      { name: 'claude-code-guide', description: 'Guides Claude Code usage' },
    ]

    it('mentioning only the longer name does not spuriously also match the shorter, ' +
      'textually-prefixed name', () => {
      const blocks = extractAgentMentionBlocks('please consult @claude-code-guide about this', roster)
      expect(blocks).toHaveLength(1)
      expect(blocks[0]).toContain('agent: "claude-code-guide"')
    })

    it('mentioning only the shorter name still matches it on its own', () => {
      const blocks = extractAgentMentionBlocks('please consult @claude about this', roster)
      expect(blocks).toHaveLength(1)
      expect(blocks[0]).toContain('agent: "claude"')
    })

    it('mentioning both produces both blocks', () => {
      const blocks = extractAgentMentionBlocks('either @claude or @claude-code-guide works', roster)
      expect(blocks).toHaveLength(2)
    })

    it('a boundary check does not break matching when followed immediately by ' +
      'punctuation that is not a valid name-continuation character', () => {
      const blocks = extractAgentMentionBlocks('cc @claude, thanks!', roster)
      expect(blocks).toHaveLength(1)
      expect(blocks[0]).toContain('agent: "claude"')
    })

    it('the same collision applies across the plugin-namespacing ":" separator', () => {
      const pluginRoster: AgentMentionSource[] = [
        { name: 'plugin-x:deploy', description: 'Deploys' },
        { name: 'plugin-x:deployer', description: 'A different, longer-named agent' },
      ]
      const blocks = extractAgentMentionBlocks('run @plugin-x:deployer now', pluginRoster)
      expect(blocks).toHaveLength(1)
      expect(blocks[0]).toContain('agent: "plugin-x:deployer"')
    })
  })
})
