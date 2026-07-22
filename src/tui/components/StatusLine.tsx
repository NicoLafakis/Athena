// src/tui/components/StatusLine.tsx
import { Box, Text } from 'ink'
import type { AppStatus } from '../App.js'

function modeColor(mode: AppStatus['mode']): string | undefined {
  if (mode === 'plan') return 'blue'
  if (mode === 'trusted') return 'red'
  return undefined
}

export function StatusLine(props: AppStatus & { busy: boolean }) {
  return (
    <Box>
      <Text dimColor>
        {props.cwd}
        {props.gitBranch ? ` · ⎇ ${props.gitBranch}` : ''}
        {' · '}
        {props.model}
        {' · '}
        {props.effort}
        {' · '}
      </Text>
      <Text color={modeColor(props.mode)} dimColor={modeColor(props.mode) === undefined}>
        {props.mode}
      </Text>
      <Text dimColor>
        {' · ctx '}
        {Math.round(props.contextPct)}%{props.busy ? ' · (esc to interrupt)' : ''}
      </Text>
    </Box>
  )
}
