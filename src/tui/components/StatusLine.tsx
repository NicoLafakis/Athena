// src/tui/components/StatusLine.tsx
import { Box, Text } from 'ink'
import type { AppStatus } from '../App.js'

function modeColor(mode: AppStatus['mode']): string | undefined {
  if (mode === 'plan') return 'blue'
  if (mode === 'trusted') return 'red'
  return undefined
}

/** The three text segments the status line renders, split out as a single source of
 *  truth: the component below colors each one independently, and App.tsx's fullscreen
 *  row budgeting (see wrappedRowCount in viewport.ts) measures their combined length to
 *  estimate how many terminal rows this fixed footer actually wraps to at the current
 *  column width — cwd/branch/model can run long enough to wrap well before an 80-column
 *  terminal narrows much, so assuming it's always exactly one row is the same class of
 *  bug the PermissionDialog chrome fix addresses.
 *
 *  `busy` is kept on the shared props type (rather than trimmed now that this line no
 *  longer reacts to it) because callers already pass the full AppStatus & { busy }
 *  shape — see BusyIndicator.tsx for the "(esc to interrupt)" hint and animated
 *  working indicator this segment used to carry, moved out to avoid showing the same
 *  text in two places on screen at once. */
function statusLineParts(props: AppStatus & { busy: boolean }): { left: string; mode: string; right: string } {
  return {
    left: `${props.cwd}${props.gitBranch ? ` · ⎇ ${props.gitBranch}` : ''} · ${props.model} · ${props.effort} · `,
    mode: props.mode,
    right: ` · ctx ${Math.round(props.contextPct)}%`,
  }
}

/** Plain-text (no ANSI/Ink markup) render of the whole status line — see
 *  statusLineParts above for why this is a single source of truth shared with the
 *  component's own render. */
export function statusLineText(props: AppStatus & { busy: boolean }): string {
  const { left, mode, right } = statusLineParts(props)
  return `${left}${mode}${right}`
}

export function StatusLine(props: AppStatus & { busy: boolean }) {
  const { left, mode, right } = statusLineParts(props)
  return (
    <Box>
      <Text dimColor>{left}</Text>
      <Text color={modeColor(props.mode)} dimColor={modeColor(props.mode) === undefined}>
        {mode}
      </Text>
      <Text dimColor>{right}</Text>
    </Box>
  )
}
