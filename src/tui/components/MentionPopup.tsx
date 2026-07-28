// src/tui/components/MentionPopup.tsx
// Renamed from FileMentionPopup.tsx: the '@' picker is now files+agents combined (an
// Athena-specific extension beyond Claude Code's files-only '@' — see agentMention.ts),
// so this renders whichever kind of MentionCandidate (agentMention.ts) each row is.
import { Box, Text } from 'ink'
import type { MentionCandidate } from '../agentMention.js'
import { popupLine, popupTextColumns, type PopupLayout } from '../popupWindow.js'

export interface MentionPopupProps {
  query: string
  matches: readonly MentionCandidate[]
  index: number
  /** True while the initial project file walk is still in flight — distinguishes
   *  "nothing matched yet" from "no files indexed yet" in the empty state. Agent
   *  matches never depend on this (agent defs are already loaded synchronously), so
   *  agent rows can appear in `matches` even while this is still true. */
  loading?: boolean
  /** Which slice to draw and how tall it is, computed by the OWNER (InputBox) via
   *  popupLayout so the rows drawn here and the rows reserved in App.tsx's fullscreen
   *  budget are the same number by construction — see popupWindow.ts. */
  layout: PopupLayout
  /** Terminal column count, so every row can be held to exactly one row (popupLine). */
  columns?: number
}

/** Unified '@' picker, overlaid above InputBox the same way PermissionDialog overlays
 *  it — bordered box, windowed list, inverse highlight on the active row (same visual
 *  language as SessionPicker/SlashMenuPopup). Each row carries an explicit "[agent]" or
 *  "[file]" tag plus a distinct color for agent rows, so the user always knows which
 *  kind of reference they're about to pick before selecting (agent rows also show the
 *  agent's description since there's no file content preview to fall back on). Purely
 *  presentational: InputBox owns all the key handling and just feeds this component
 *  query/matches/index. */
export function MentionPopup({ query, matches, index, loading, layout, columns = 80 }: MentionPopupProps) {
  const width = popupTextColumns(columns)
  if (matches.length === 0) {
    return (
      <Box borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text dimColor>
          {popupLine(loading ? 'Indexing project files…' : `No files or agents match @${query}`, width)}
        </Text>
      </Box>
    )
  }
  // Windowed render: keep the selection visible without drawing an unbounded list. The
  // window itself comes from `layout` (popupWindow.ts) rather than being recomputed here.
  const { start, count } = layout
  const visible = matches.slice(start, start + count)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        {popupLine(`@${query} (↑/↓ select, Tab/Enter confirm, Esc cancel)`, width)}
      </Text>
      {start > 0 && <Text dimColor>… {start} earlier</Text>}
      {visible.map((candidate, i) => {
        const abs = start + i
        const active = abs === index
        const isAgent = candidate.kind === 'agent'
        const tail = isAgent && candidate.description ? ` — ${candidate.description}` : ''
        return (
          <Text
            key={`${candidate.kind}:${candidate.value}`}
            color={active ? 'cyan' : isAgent ? 'magenta' : undefined}
            inverse={active}
          >
            {popupLine(`${isAgent ? '[agent] ' : '[file] '}${candidate.value}${tail}`, width)}
          </Text>
        )
      })}
      {start + count < matches.length && <Text dimColor>… {matches.length - start - count} more</Text>}
    </Box>
  )
}
