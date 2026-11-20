import React, { useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'
import { createFullscreenController } from './fullscreen.js'
import { wrappedRowCount } from './viewport.js'
import {
  hasActiveBrainHeat,
  renderBrainOrbitalLines,
  topFiringNodes,
} from '../voice/brain-map.js'
import {
  formatHandoffElapsed,
  renderLevelBar,
  renderWaveformBars,
  type VoiceHudFeedEntry,
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

/**
 * Fullscreen split-screen Voice HUD:
 * - Sticky top header: phase badge + dual live mic & Athena waveforms
 * - Left pane: scrollable conversation history (PgUp/PgDn, Ctrl+PgUp/Ctrl+PgDn)
 *   + pinned Hand-Offs & Background Tasks timer bar
 * - Right pane (cols >= 92): live Unicode Braille orbital EEG neural scan driven by
 *   Athena's EngineEventBus and voice activity
 * - Sticky 1-row footer
 */
export function VoiceHud({ store }: VoiceHudProps) {
  const { stdout } = useStdout()
  const [state, setState] = useState<VoiceHudState>(() => store.getState())
  const [tickNow, setTickNow] = useState<number>(() => Date.now())
  const [spinIdx, setSpinIdx] = useState(0)
  const [scrollFromBottom, setScrollFromBottom] = useState(0)
  const [eegOverride, setEegOverride] = useState<boolean | null>(null)
  const [dims, setDims] = useState(() => ({
    cols: stdout?.columns ?? 120,
    rows: stdout?.rows ?? 30,
  }))

  // Enter alternate screen buffer on TTY and always restore on unmount/exit
  useEffect(() => {
    const ctrl = createFullscreenController(stdout)
    ctrl.enter()
    const onResize = () => {
      setDims({ cols: stdout?.columns ?? 120, rows: stdout?.rows ?? 30 })
    }
    stdout?.on?.('resize', onResize)
    return () => {
      stdout?.off?.('resize', onResize)
      ctrl.dispose()
    }
  }, [stdout])

  useEffect(() => {
    setState(store.getState())
    return store.subscribe(setState)
  }, [store])

  const runningCount = state.handoffs.filter((h) => h.status === 'running').length
  const brainHot = hasActiveBrainHeat(state.brain)

  // Live spinner + elapsed timer + EEG cooling decay tick (0% CPU when idle!)
  useEffect(() => {
    if (runningCount === 0 && !brainHot) return
    const timer = setInterval(() => {
      const now = Date.now()
      setTickNow(now)
      if (runningCount > 0) setSpinIdx((i) => (i + 1) % SPINNER_FRAMES.length)
      if (brainHot) store.dispatch({ type: 'brain-decay', now })
    }, 150)
    return () => clearInterval(timer)
  }, [runningCount, brainHot, store])

  const cols = Math.max(60, dims.cols)
  const rows = Math.max(16, dims.rows)
  const canSplit = cols >= 92
  const showEeg = eegOverride ?? canSplit
  const showChat = canSplit || !showEeg

  // Strict fullscreen row budget (AGENTS.md §1):
  // Sticky header: 5 rows (border 2 + title 1 + dual meters 2)
  // Sticky footer: 1 row
  // Middle split container: rows - 6
  const HEADER_ROWS = 5
  const FOOTER_ROWS = 1
  const middleRows = Math.max(10, rows - HEADER_ROWS - FOOTER_ROWS)

  const leftWidth = showChat ? (showEeg ? Math.floor(cols * 0.56) : cols) : 0
  const rightWidth = showEeg ? (showChat ? cols - leftWidth : cols) : 0

  // Left pane split: scrollable feed on top, compact hand-offs strip pinned on bottom
  const visibleHandoffs = state.handoffs.slice(-2)
  const handoffRows = 2 + 1 + Math.max(1, visibleHandoffs.length) // border(2) + title(1) + items
  const feedBoxRows = Math.max(5, middleRows - handoffRows)
  const feedContentRows = Math.max(2, feedBoxRows - 3) // border(2) + header(1)
  const feedTextWidth = Math.max(20, leftWidth - 4)

  // Compute wrapped row counts per feed entry so scrolling lands cleanly inside the viewport
  const entryHeights = useMemo(
    () =>
      state.feed.map((entry) => {
        const prefix = `[${entry.timestamp}] ${entry.role === 'user' ? 'You' : entry.role === 'athena' ? 'Athena' : 'Sys'}: `
        return wrappedRowCount(`${prefix}${entry.text}`, feedTextWidth)
      }),
    [state.feed, feedTextWidth],
  )

  const maxScroll = Math.max(0, state.feed.length - 1)
  const clampedScroll = Math.min(scrollFromBottom, maxScroll)

  // Keyboard controls (obeys AGENTS.md §5: PageUp/PageDown + Ctrl+PageUp/Ctrl+PageDown;
  // Tab / B toggles EEG visualization so it never conflicts with Ctrl+C exit)
  useInput((input, key) => {
    if (key.tab || (!key.ctrl && !key.meta && input.toLowerCase() === 'b')) {
      setEegOverride((prev) => !(prev ?? canSplit))
      return
    }
    if (key.pageUp) {
      if (key.ctrl) {
        setScrollFromBottom(maxScroll)
      } else {
        setScrollFromBottom((prev) => Math.min(maxScroll, prev + Math.max(2, Math.floor(feedContentRows / 2))))
      }
      return
    }
    if (key.pageDown) {
      if (key.ctrl) {
        setScrollFromBottom(0)
      } else {
        setScrollFromBottom((prev) => Math.max(0, prev - Math.max(2, Math.floor(feedContentRows / 2))))
      }
    }
  })

  // Slice visible feed entries from the bottom anchor upward to fit `feedContentRows`
  const visibleFeed: VoiceHudFeedEntry[] = useMemo(() => {
    if (state.feed.length === 0) return []
    const endIdx = Math.max(0, state.feed.length - 1 - clampedScroll)
    const picked: VoiceHudFeedEntry[] = []
    let usedRows = 0
    for (let i = endIdx; i >= 0; i--) {
      const h = entryHeights[i] ?? 1
      if (picked.length > 0 && usedRows + h > feedContentRows) break
      picked.unshift(state.feed[i]!)
      usedRows += h
    }
    return picked
  }, [state.feed, entryHeights, clampedScroll, feedContentRows])

  // Right pane: orbital Braille canvas + 2-line hot subsystems telemetry
  const brainCanvasCols = Math.max(20, rightWidth - 4)
  const brainCanvasRows = Math.max(6, middleRows - 6) // border(2) + title(1) + telemetry(3)
  const orbitalRows = useMemo(
    () => (showEeg ? renderBrainOrbitalLines(state.brain, brainCanvasCols, brainCanvasRows) : []),
    [showEeg, state.brain, brainCanvasCols, brainCanvasRows],
  )
  const hotNodes = useMemo(() => topFiringNodes(state.brain, 3), [state.brain])

  const badge = PHASE_BADGE[state.phase]
  const micActive = state.micLevel > 8 || state.phase === 'hearing'
  const athenaActive = state.athenaLevel > 5 || state.phase === 'speaking'
  const waveWidth = Math.max(8, Math.min(24, Math.floor((cols - 52) / 2)))

  return (
    <Box flexDirection="column" height={rows} width={cols}>
      {/* STICKY TOP HEADER (exact 5 rows) */}
      <Box
        flexDirection="column"
        height={HEADER_ROWS}
        borderStyle="round"
        borderColor={badge.color}
        paddingX={1}
        overflow="hidden"
      >
        <Box justifyContent="space-between">
          <Text bold color="cyanBright" wrap="truncate-end">
            ✦ ATHENA VOICE · {state.projectName} · {state.model}
          </Text>
          <Text bold color={badge.color} wrap="truncate-end">
            {badge.label}
          </Text>
        </Box>
        <Box justifyContent="space-between">
          <Text wrap="truncate-end">
            <Text bold color={micActive ? 'greenBright' : 'white'}>YOU </Text>
            <Text color={micActive ? 'greenBright' : 'gray'}>{renderWaveformBars(state.micHistory, waveWidth)} </Text>
            <Text dimColor>{renderLevelBar(state.micLevel, 8)}</Text>
          </Text>
          <Text wrap="truncate-end">
            <Text bold color={athenaActive ? 'cyanBright' : 'white'}>ATHENA </Text>
            <Text color={athenaActive ? 'cyanBright' : 'gray'}>{renderWaveformBars(state.athenaHistory, waveWidth)} </Text>
            <Text dimColor>{renderLevelBar(state.athenaLevel, 8)}</Text>
          </Text>
        </Box>
        <Box justifyContent="space-between">
          <Text dimColor={!state.liveHypothesis} color={state.liveHypothesis ? 'yellow' : undefined} wrap="truncate-end">
            {state.liveHypothesis ? `“${state.liveHypothesis}”` : state.lastStatus}
          </Text>
          {clampedScroll > 0 && (
            <Text color="yellow" bold>
              ↑ +{clampedScroll} newer (Ctrl+PgDn)
            </Text>
          )}
        </Box>
      </Box>

      {/* MIDDLE SPLIT VIEWPORT (exact middleRows, clipped) */}
      <Box flexDirection="row" height={middleRows} overflow="hidden">
        {/* LEFT PANE: Scrollable Conversation + Pinned Hand-Off Strip */}
        {showChat && (
        <Box flexDirection="column" width={leftWidth} height={middleRows} overflow="hidden">
          {/* Scrollable Conversation Container */}
          <Box
            flexDirection="column"
            height={feedBoxRows}
            borderStyle="single"
            borderColor="gray"
            paddingX={1}
            overflow="hidden"
          >
            <Box justifyContent="space-between">
              <Text bold dimColor>
                CONVERSATION ({state.feed.length})
              </Text>
              <Text dimColor>
                {clampedScroll > 0 ? 'SCROLLED · PgDn for live' : 'LIVE · PgUp to scroll'}
              </Text>
            </Box>
            {visibleFeed.length === 0 ? (
              <Text dimColor>Just start speaking — full-duplex mic is live.</Text>
            ) : (
              visibleFeed.map((entry) => (
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

          {/* Pinned Hand-Offs & Background Tasks Strip */}
          <Box
            flexDirection="column"
            height={handoffRows}
            borderStyle="single"
            borderColor={runningCount > 0 ? 'blueBright' : 'gray'}
            paddingX={1}
            overflow="hidden"
          >
            <Box justifyContent="space-between">
              <Text bold color={runningCount > 0 ? 'blueBright' : undefined} dimColor={runningCount === 0}>
                HAND-OFFS &amp; TASKS
              </Text>
              <Text bold={runningCount > 0} color={runningCount > 0 ? 'blueBright' : undefined} dimColor={runningCount === 0}>
                {runningCount > 0
                  ? `${SPINNER_FRAMES[spinIdx]} ${runningCount} ACTIVE`
                  : state.handoffs.length > 0
                    ? `${state.handoffs.length} recent`
                    : 'IDLE (voice only)'}
              </Text>
            </Box>
            {visibleHandoffs.length === 0 ? (
              <Text dimColor wrap="truncate-end">
                No active hand-offs — no background agent running.
              </Text>
            ) : (
              visibleHandoffs.map((h) => {
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
                const tag =
                  h.status === 'running' ? 'RUN' : h.status === 'completed' ? 'DONE' : 'ERR'
                return (
                  <Text key={h.id} wrap="truncate-end">
                    <Text bold color={color}>
                      {icon} [{elapsed}] {tag}
                    </Text>
                    <Text dimColor> · </Text>
                    <Text>{h.label}</Text>
                  </Text>
                )
              })
            )}
          </Box>
        </Box>
        )}

        {/* RIGHT PANE: Live Orbital EEG Neural Scan */}
        {showEeg && (
          <Box
            flexDirection="column"
            width={rightWidth}
            height={middleRows}
            borderStyle="single"
            borderColor={hotNodes.length > 0 ? 'cyan' : 'gray'}
            paddingX={1}
            overflow="hidden"
          >
            <Box justifyContent="space-between">
              <Text bold color={hotNodes.length > 0 ? 'cyanBright' : 'white'}>
                NEURAL SCAN · EEG
              </Text>
              <Text dimColor>
                {hotNodes.length > 0 ? `${hotNodes.length} FIRING` : 'RESTING'}
              </Text>
            </Box>

            <Box flexDirection="column" height={brainCanvasRows} overflow="hidden">
              {orbitalRows.map((row, rIdx) => (
                <Text key={rIdx} wrap="truncate-end">
                  {row.segments.map((seg, sIdx) => (
                    <Text
                      key={sIdx}
                      color={seg.color}
                      bold={seg.bold}
                      dimColor={seg.dimColor}
                    >
                      {seg.text}
                    </Text>
                  ))}
                </Text>
              ))}
            </Box>

            {/* Compact Live Firing Readout */}
            <Box flexDirection="column" height={3} overflow="hidden">
              <Text bold dimColor wrap="truncate-end">
                ACTIVE PATHWAYS
              </Text>
              {hotNodes.length === 0 ? (
                <Text dimColor wrap="truncate-end">
                  Core idling — speak or delegate to watch subsystems fire.
                </Text>
              ) : (
                <>
                  <Text wrap="truncate-end">
                    {hotNodes.map((n, idx) => {
                      const pct = Math.round(n.heat * 100)
                      const bars = '█'.repeat(Math.max(1, Math.round(n.heat * 5)))
                      return (
                        <Text key={n.id}>
                          {idx > 0 ? ' · ' : ''}
                          <Text bold color={n.color}>
                            {n.label}
                          </Text>{' '}
                          <Text color={n.color}>{bars}</Text>
                          <Text dimColor> {pct}%</Text>
                        </Text>
                      )
                    })}
                  </Text>
                  <Text dimColor wrap="truncate-end">
                    Last: {hotNodes[0]!.label} ({hotNodes[0]!.reason || 'active'})
                  </Text>
                </>
              )}
            </Box>
          </Box>
        )}
      </Box>

      {/* STICKY FOOTER (exact 1 row) */}
      <Box height={FOOTER_ROWS} paddingX={1} justifyContent="space-between" overflow="hidden">
        <Text dimColor wrap="truncate-end">
          {cols >= 84
            ? 'PgUp/PgDn scroll · Ctrl+PgDn latest · Tab/B toggle EEG · Ctrl+C quit'
            : 'PgUp/Dn scroll · Tab/B EEG · Ctrl+C quit'}
        </Text>
        <Text dimColor wrap="truncate-end">
          {showEeg ? (showChat ? 'EEG split' : 'EEG full') : 'Chat only'}
        </Text>
      </Box>
    </Box>
  )
}
