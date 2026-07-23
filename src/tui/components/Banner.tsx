// src/tui/components/Banner.tsx — Athena-branded startup header for fullscreen mode.
// Fixed row above the transcript for as long as fullscreen is active, mirroring how
// StatusLine is a fixed footer row (see App.tsx) rather than a one-shot splash that
// scrolls away: simplest lifecycle, and it never fights the transcript virtualization
// budget since its own row count is constant (see BANNER_ROWS in App.tsx).
import { Box, Text } from 'ink'

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

/** Compact Athena wordmark + Greek-key border + version/model/cwd line — four rows total
 *  (see BANNER_ROWS in App.tsx), well inside the "handful of lines" budget so it coexists
 *  with the scrollable transcript and pinned input rather than acting as a full splash. */
export function Banner({ version, model, cwd, columns = 80 }: BannerProps) {
  const width = Math.max(MIN_WIDTH, Math.min(columns, MAX_WIDTH))
  return (
    <Box flexDirection="column">
      <Text color="blue">{keyLine(KEY_UNIT_TOP, width)}</Text>
      <Text bold color="blue">
        {'  '}ATHENA
      </Text>
      <Text color="blue">{keyLine(KEY_UNIT_BOTTOM, width)}</Text>
      <Text dimColor>
        {'v'}
        {version}
        {' · '}
        {model}
        {' · '}
        {cwd}
      </Text>
    </Box>
  )
}
