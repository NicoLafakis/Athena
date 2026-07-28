// src/tui/components/Banner.tsx — Athena-branded startup header for fullscreen mode.
// Fixed row above the transcript for as long as fullscreen is active, mirroring how
// StatusLine is a fixed footer row (see App.tsx) rather than a one-shot splash that
// scrolls away: simplest lifecycle, and its height is reported to App's row budget by
// bannerRowCount below.
import { Box, Text } from 'ink'
import { wrappedRowCount } from '../viewport.js'

// Greek key (meander) motif, built from the box-drawing "bracket" glyphs the task brief
// itself suggested (␣▛▀▜␣-style repeating units): ▛▀▜ reads as an up-facing step and
// ▙▄▟ as a down-facing one, so pairing them top/bottom of the wordmark gives a framed,
// alternating-step border that's recognizably Greek-key rather than a plain rule line.
const KEY_UNIT_TOP = '▛▀▜ '
const KEY_UNIT_BOTTOM = '▙▄▟ '
const MIN_WIDTH = 24
const MAX_WIDTH = 100

function keyLine(unit: string, width: number): string {
  return unit.repeat(Math.ceil(width / unit.length)).slice(0, width)
}

export interface BannerProps {
  version: string
  model: string
  cwd: string
  /** Terminal column count, so the Greek-key border fills the row instead of a fixed
   *  guess. Defaults to 80, matching viewport.ts's own row-estimation fallback. */
  columns?: number
}

const WORDMARK_TEXT = '  ATHENA'
function bannerWidth(columns: number): number {
  return Math.max(MIN_WIDTH, Math.min(columns, MAX_WIDTH))
}

/** The banner's info row as one string, so App's row budgeting (see bannerRowCount) can
 *  measure the SAME text this component renders rather than a re-derived approximation —
 *  the discipline statusLineText/todoLineText/busyIndicatorText already follow. */
export function bannerInfoText(version: string, model: string, cwd: string): string {
  return `v${version} · ${model} · ${cwd}`
}

/** EXACT rows Banner occupies at the given terminal width. NOT a constant, despite the
 *  component rendering a fixed FOUR <Text> children: two of those four are
 *  arbitrary-length, wrap-eligible content. The info row carries a cwd, which is routinely
 *  longer than a narrow terminal is wide (a 30-column split pane turns it into three
 *  rows), and the Greek-key rules are clamped to MIN_WIDTH, so below 24 columns they wrap
 *  too. Treating the banner as a flat 4 rows undercounted it by 2+ on exactly those
 *  terminals — and in fullscreen's fixed-height column an undercount is not a clipped
 *  banner, it is Yoga shrinking siblings and Ink overwriting their lines (the wordmark
 *  fused onto its own border rule, the status line drawn across itself), all at an
 *  unchanged frame height. Same reason StatusLine, TodoPanel items and the dialog's
 *  header/summary/reason are all measured with wrappedRowCount instead of assumed to be
 *  one row: "fixed number of Text children" and "fixed number of ROWS" are not the same
 *  claim. */
export function bannerRowCount({ version, model, cwd, columns = 80 }: BannerProps): number {
  const width = bannerWidth(columns)
  // Both rules are built from same-length units, so one measurement covers both.
  const ruleRows = wrappedRowCount(keyLine(KEY_UNIT_TOP, width), columns)
  return (
    ruleRows * 2 +
    wrappedRowCount(WORDMARK_TEXT, columns) +
    wrappedRowCount(bannerInfoText(version, model, cwd), columns)
  )
}

/** Compact Athena wordmark + Greek-key border + version/model/cwd line — a handful of
 *  rows (measured exactly by bannerRowCount above) so it coexists with the scrollable
 *  transcript and pinned input rather than acting as a full splash. */
export function Banner({ version, model, cwd, columns = 80 }: BannerProps) {
  const width = bannerWidth(columns)
  return (
    <Box flexDirection="column">
      <Text color="blue">{keyLine(KEY_UNIT_TOP, width)}</Text>
      <Text bold color="blue">
        {WORDMARK_TEXT}
      </Text>
      <Text color="blue">{keyLine(KEY_UNIT_BOTTOM, width)}</Text>
      <Text dimColor>{bannerInfoText(version, model, cwd)}</Text>
    </Box>
  )
}
