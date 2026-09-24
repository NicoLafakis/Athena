// src/tui/components/StatusLine.tsx
import { Text } from 'ink'
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
function statusLineParts(props: StatusLineProps): {
  left: string
  mode: string
  right: string
  scroll: string
} {
  return {
    left: `${props.cwd}${props.gitBranch ? ` · ⎇ ${props.gitBranch}` : ''} · ${props.model} · ${props.effort} · `,
    mode: props.mode,
    right: ` · ctx ${Math.round(props.contextPct)}%`,
    scroll: scrollNoticeText(props.scrolledBelow ?? 0, props.scrolled ?? false),
  }
}

/** `scrolledBelow` is how many transcript entries sit BELOW the scrolled-up viewport;
 *  `scrolled` remains true when the anchor is inside the newest entry. The notice
 *  deliberately lives on the pinned status footer rather than as an extra line at the
 *  transcript's edge: App.tsx already
 *  measures this line's real wrapped height into its fullscreen row budget, so the notice
 *  can never become an unbudgeted row that overflows the frame. Same "… N more" phrasing
 *  as SlashMenuPopup/DiffPreview/TodoPanel's truncation notices. */
export function scrollNoticeText(scrolledBelow: number, scrolled = scrolledBelow > 0): string {
  if (!scrolled) return ''
  return scrolledBelow > 0
    ? ` · ↑ scrolled, … ${scrolledBelow} more below (PgDn)`
    : ' · ↑ scrolled (PgDn)'
}

export type StatusLineProps = AppStatus & { busy: boolean; scrolledBelow?: number; scrolled?: boolean }

/** Plain-text (no ANSI/Ink markup) render of the whole status line — see
 *  statusLineParts above for why this is a single source of truth shared with the
 *  component's own render. */
export function statusLineText(props: StatusLineProps): string {
  const { left, mode, right, scroll } = statusLineParts(props)
  return `${left}${mode}${right}${scroll}`
}

/** One <Text> with NESTED (inline) colored spans, deliberately not a <Box> of sibling
 *  <Text>es. A Box lays its children out as a flex ROW: each segment gets its own share of
 *  the width and wraps inside it, so at a narrow terminal the footer's real height is a
 *  function of how Yoga divided the columns between four independent boxes — which
 *  statusLineText, being a single concatenated string, cannot model. App.tsx budgets this
 *  footer's rows from exactly that string (wrappedRowCount), and in fullscreen's
 *  fixed-height column an undercounted footer is a corrupted frame, not a clipped one:
 *  Yoga shrinks the sibling boxes and Ink draws the cwd segment straight through the mode
 *  and ctx segments. Nested <Text> is inline instead — the whole line wraps as ONE flow of
 *  text, which is precisely what statusLineText measures, so the estimate is exact by
 *  construction rather than by luck at 80 columns. Colors are unaffected. */
export function StatusLine(props: StatusLineProps) {
  const { left, mode, right, scroll } = statusLineParts(props)
  return (
    <Text dimColor>
      {left}
      <Text color={modeColor(props.mode)} dimColor={modeColor(props.mode) === undefined}>
        {mode}
      </Text>
      {right}
      {scroll ? <Text color="yellow">{scroll}</Text> : null}
    </Text>
  )
}
