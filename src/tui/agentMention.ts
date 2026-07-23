// src/tui/agentMention.ts
// Pure logic behind the agent half of the unified '@' picker in InputBox: fuzzy ranking
// of AgentOrchestrator.listDefs() entries, submit-time re-scan/extraction of agent
// mentions still literally present in the final text, and the combined files+agents
// candidate ranking the popup renders. Kept Ink-free and side-effect-free, mirroring
// fileMention.ts's split from FileMentionPopup.tsx (now MentionPopup.tsx).
import Fuse from 'fuse.js'
import type { AgentDef } from '../brain/loader.js'
import { rankFileMatches } from './fileMention.js'

/** Minimal shape extractAgentMentionBlocks/rankAgentMatches actually need — accepting
 *  this instead of the full AgentDef keeps these pure functions trivially testable with
 *  small literal fixtures instead of full loader.ts records. */
export type AgentMentionSource = Pick<AgentDef, 'name' | 'description'>

/** Pure fuzzy-rank of a query against known agent defs (by name AND description) — no
 *  Ink, no orchestrator, unit-testable in isolation. An empty query returns the first
 *  `limit` agents (alphabetical by name) so the popup isn't blank the instant '@' is
 *  typed, mirroring rankFileMatches' empty-query behavior. */
export function rankAgentMatches<T extends AgentMentionSource>(
  query: string,
  agents: readonly T[],
  limit = 10,
): T[] {
  if (agents.length === 0) return []
  if (query.trim() === '') return [...agents].sort((a, b) => a.name.localeCompare(b.name)).slice(0, limit)
  const fuse = new Fuse(agents, { threshold: 0.4, ignoreLocation: true, keys: ['name', 'description'] })
  return fuse
    .search(query)
    .slice(0, limit)
    .map((r) => r.item)
}

/** A single row in the unified '@' picker — either a project file or an invocable
 *  agent, tagged so MentionPopup can render a visually distinct row per kind (spec:
 *  the user must always know which kind of reference they're about to pick). */
export type MentionCandidateKind = 'file' | 'agent'

export interface MentionCandidate {
  kind: MentionCandidateKind
  /** The literal text spliced in after '@' on selection: a relative file path for
   *  'file', the (possibly plugin-namespaced 'plugin-id:name') agent name for 'agent'. */
  value: string
  /** Agent description, shown alongside the name so the user can tell agents apart
   *  without leaving the popup. Undefined for file rows. */
  description?: string
}

/** Combines file and agent matches into the single ranked list the popup shows.
 *
 *  Design choice: agents get their OWN ranking pass (via rankAgentMatches, matched on
 *  name AND description) and are placed FIRST, with files (via the existing
 *  rankFileMatches) filling whatever slots remain up to `limit`. This is a grouped
 *  two-section list, not a single fuzzy-sorted merge, for two reasons: (1) Fuse.js
 *  scores from two independently-configured Fuse instances (different key sets, wildly
 *  different corpus sizes) aren't comparable, so interleaving by raw score would be
 *  arbitrary; (2) agents are a small, deliberately-curated set representing explicit
 *  delegation targets — in a repo with thousands of files they must never be crowded
 *  out of the window by coincidental filename fuzzy-matches. Grouping also keeps the
 *  "visually distinguish agent rows from file rows" requirement trivial: agents are
 *  simply the leading contiguous block. */
export function rankMentionCandidates<T extends AgentMentionSource>(
  query: string,
  files: readonly string[],
  agents: readonly T[],
  limit = 10,
): MentionCandidate[] {
  const agentMatches = rankAgentMatches(query, agents, limit)
  const remaining = Math.max(0, limit - agentMatches.length)
  const fileMatches = remaining > 0 ? rankFileMatches(query, files, remaining) : []
  return [
    ...agentMatches.map(
      (a): MentionCandidate => ({ kind: 'agent', value: a.name, description: a.description }),
    ),
    ...fileMatches.map((f): MentionCandidate => ({ kind: 'file', value: f })),
  ]
}

/** Wraps an agent reference in a clearly-labeled block distinct from formatMentionBlock
 *  (fileMention.ts) — there is no file content to inject, only guidance: the agent's
 *  name/description, and an instruction for the model to consider invoking the EXISTING
 *  Agent tool (src/tools/agent.ts) if delegating to it fits the request. This is context
 *  for the model to act on via its own tool-calling behavior — it never itself invokes
 *  runAgent or bypasses the model's turn loop. */
export function formatAgentMentionBlock(agent: AgentMentionSource): string {
  return (
    `--- @${agent.name} (agent) ---\n` +
    `The user referenced the agent "${agent.name}": ${agent.description}\n` +
    `If delegating (part of) this request to it is appropriate, consider invoking the Agent tool with agent: "${agent.name}".\n` +
    `--- end @${agent.name} ---`
  )
}

/** Characters that can continue a mention token once one has started, for AGENT names —
 *  plain slug words plus the ':' plugin-namespacing separator (brain/plugins.ts:
 *  `<plugin-id>:<name>`). This is checked immediately after a matched `@name` so a
 *  shorter agent name that happens to be a literal prefix of a longer one (e.g. "claude"
 *  vs "claude-code-guide" — a real pairing among Claude Code's own subagent roster)
 *  can't spuriously match inside a mention of the longer one: extractAgentMentionBlocks
 *  scans the FULL agent universe (unlike fileMention.ts's per-turn "mentioned so far"
 *  cache), so this collision surface is real, not hypothetical. */
const AGENT_NAME_CONTINUATION_CHARS = 'A-Za-z0-9_:-'

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** True if `@name` appears in `text` as a whole mention token — i.e. not merely as a
 *  substring prefix of some longer `@name...` token also present in the text. */
function hasWholeAgentMention(text: string, name: string): boolean {
  const re = new RegExp(`@${escapeRegExp(name)}(?![${AGENT_NAME_CONTINUATION_CHARS}])`)
  return re.test(text)
}

/** Scans the literal submitted text for @agent-name mentions and returns context blocks
 *  only for agents that still appear in it — same "re-scan at submit time" discipline as
 *  extractMentionBlocks (fileMention.ts), so a stale/history-recalled or backspaced-away
 *  agent mention can't drag guidance along for an agent the user is no longer
 *  referencing. Unlike files, there's no cached read to look up: every known agent def is
 *  cheap to re-check against `agents` (already fully loaded in memory), so this takes the
 *  full list directly rather than a "mentioned so far" cache. Each candidate name is
 *  matched as a WHOLE mention token (hasWholeAgentMention), not a bare substring, so a
 *  short name that's a textual prefix of a longer mentioned one is never a false match. */
export function extractAgentMentionBlocks(text: string, agents: readonly AgentMentionSource[]): string[] {
  const blocks: string[] = []
  for (const agent of agents) {
    if (hasWholeAgentMention(text, agent.name)) blocks.push(formatAgentMentionBlock(agent))
  }
  return blocks
}
