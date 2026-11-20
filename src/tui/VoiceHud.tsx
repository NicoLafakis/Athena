import React, { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import {
  formatHandoffElapsed,
  renderLevelBar,
  renderWaveformBars,
  type VoiceHudPhase,
  type VoiceHudState,
  type VoiceHudStore,
} from '../voice/visualizer.js'

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

const PHASE_BADGE: Record<VoiceHudPhase, { label: string; color: string }> = {
  connecting: { label: '◌ CONNECTING', color: 'yellow' },
  standby: { label: '● READY — Speak anytime', color: 'green' },
  hearing: { label: '◉ HEARING YOU', color: 'greenBright' },
  working: { label: '◈ WORKING', color: 'blueBright' },
  speaking: { label: '◉ ATHENA SPEAKING', color: 'cyanBright' },
  permission: { label: '⚠ PERMISSION REQUIRED', color: 'redBright' },
  stopped: { label: '○ STOPPED', color: 'gray' },
}

export interface VoiceHudProps {
  store: VoiceHudStore
}

export function VoiceHud({ store }: VoiceHudProps) {
  const [state, setState] = useState<VoiceHudState>(() => store.getState())
  const [tickNow, setTickNow] = useState<number>(() => Date.now())
  const [spinIdx, setSpinIdx] = useState(0)

  useEffect(() => {
    setState(store.getState())
    return store.subscribe(setState)
  }, [store])

  const runningCount = state.handoffs.filter((h) => h.status === 'running').length

  useEffect(() => {
    if (runningCount === 0) return
    const timer = setInterval(() => {
      setTickNow(Date.now())
      setSpinIdx((i) => (i + 1) % SPINNER_FRAMES.length)
    }, 200)
    return () => clearInterval(timer)
  }, [runningCount])

  const badge = PHASE_BADGE[state.phase]
  const micActive = state.micLevel > 8 || state.phase === 'hearing'
  const athenaActive = state.athenaLevel > 5 || state.phase === 'speaking'

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      {/* Header */}
      <Box
        borderStyle="round"
        borderColor={badge.color}
        paddingX={1}
        justifyContent="space-between"
      >
        <Text bold color="cyanBright">
          ✦ ATHENA VOICE
        </Text>
        <Text dimColor>
          {state.projectName} · {state.model}
        </Text>
        <Text bold color={badge.color}>
          {badge.label}
        </Text>
      </Box>

      {/* Dual live visualizers */}
      <Box flexDirection="row" gap={1} marginTop={1}>
        <Box
          flexDirection="column"
          flexGrow={1}
          borderStyle="single"
          borderColor={micActive ? 'greenBright' : 'gray'}
          paddingX={1}
        >
          <Box justifyContent="space-between">
            <Text bold color={micActive ? 'greenBright' : 'white'}>
              YOU (MIC)
            </Text>
            <Text dimColor>{renderLevelBar(state.micLevel, 10)}</Text>
          </Box>
          <Text color={micActive ? 'greenBright' : 'gray'}>
            {renderWaveformBars(state.micHistory, 28)}
          </Text>
          <Text dimColor={!state.liveHypothesis} color={state.liveHypothesis ? 'yellow' : undefined} wrap="wrap">
            {state.liveHypothesis ? `“${state.liveHypothesis}”` : 'Speak naturally — mic is live…'}
          </Text>
        </Box>

        <Box
          flexDirection="column"
          flexGrow={1}
          borderStyle="single"
          borderColor={athenaActive ? 'cyanBright' : 'gray'}
          paddingX={1}
        >
          <Box justifyContent="space-between">
            <Text bold color={athenaActive ? 'cyanBright' : 'white'}>
              ATHENA (VOICE)
            </Text>
            <Text dimColor>{renderLevelBar(state.athenaLevel, 10)}</Text>
          </Box>
          <Text color={athenaActive ? 'cyanBright' : 'gray'}>
            {renderWaveformBars(state.athenaHistory, 28)}
          </Text>
          <Text dimColor>{state.lastStatus}</Text>
        </Box>
      </Box>

      {/* Hand-offs & background agent tasks with live elapsed timer */}
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor={runningCount > 0 ? 'blueBright' : 'gray'}
        paddingX={1}
        marginTop={1}
      >
        <Box justifyContent="space-between">
          <Text bold color={runningCount > 0 ? 'blueBright' : undefined} dimColor={runningCount === 0}>
            HAND-OFFS &amp; BACKGROUND TASKS
          </Text>
          <Text bold={runningCount > 0} color={runningCount > 0 ? 'blueBright' : undefined} dimColor={runningCount === 0}>
            {runningCount > 0
              ? `${SPINNER_FRAMES[spinIdx]} ${runningCount} ACTIVE`
              : state.handoffs.length > 0
                ? `${state.handoffs.length} recent`
                : 'IDLE (voice only)'}
          </Text>
        </Box>
        {state.handoffs.length === 0 ? (
          <Text dimColor>No active hand-offs — no background agent is running right now.</Text>
        ) : (
          state.handoffs.map((h) => {
            const elapsed = formatHandoffElapsed(h.startedAt, h.finishedAt ?? tickNow)
            const icon =
              h.status === 'running'
                ? SPINNER_FRAMES[spinIdx]
                : h.status === 'completed'
                  ? '✓'
                  : '✗'
            const color =
              h.status === 'running'
                ? 'blueBright'
                : h.status === 'completed'
                  ? 'green'
                  : 'redBright'
            const statusTag =
              h.status === 'running' ? 'RUNNING' : h.status === 'completed' ? 'RETURNED' : 'FAILED'
            return (
              <Box key={h.id} flexDirection="row">
                <Text wrap="wrap">
                  <Text bold color={color}>
                    {icon} [{elapsed}] {statusTag}
                  </Text>
                  <Text dimColor> · {h.target} · </Text>
                  <Text>{h.label}</Text>
                </Text>
              </Box>
            )
          })
        )}
      </Box>

      {/* Live conversation & activity feed */}
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor="gray"
        paddingX={1}
        marginTop={1}
        minHeight={6}
      >
        <Text bold dimColor>
          LIVE FEED
        </Text>
        {state.feed.length === 0 ? (
          <Text dimColor>Just start speaking — no wake word needed.</Text>
        ) : (
          state.feed.map((entry) => (
            <Box key={entry.id} flexDirection="row">
              <Text wrap="wrap">
                <Text dimColor>[{entry.timestamp}] </Text>
                <Text
                  bold
                  color={
                    entry.role === 'user'
                      ? 'greenBright'
                      : entry.role === 'athena'
                        ? 'cyanBright'
                        : 'yellow'
                  }
                >
                  {entry.role === 'user' ? 'You' : entry.role === 'athena' ? 'Athena' : 'Sys'}:{' '}
                </Text>
                <Text>{entry.text}</Text>
              </Text>
            </Box>
          ))
        )}
      </Box>

      {/* Footer */}
      <Box marginTop={0} paddingX={1}>
        <Text dimColor>
          Open conversation mode (pass --wake-word to gate on &quot;Athena&quot;) · Say &quot;stop listening&quot; or Ctrl+C to exit
        </Text>
      </Box>
    </Box>
  )
}
