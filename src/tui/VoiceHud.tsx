import React, { useEffect, useMemo, useRef, useState } from 'react'
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
  const latestStateRef = useRef<VoiceHudState>(state)
  const dirtyRef = useRef(false)
  const [tickNow, setTickNow] = useState<number>(() => Date.now())
  const [phaseRad, setPhaseRad] = useState(0)
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

  // Buffer rapid store updates (mic/athena levels, bus events) into a ref so the
  // single ~14 FPS animation clock paints one atomic DEC-2026 frame with zero flicker.
  useEffect(() => {
    latestStateRef.current = store.getState()
    setState(latestStateRef.current)
    return store.subscribe((next) => {
      latestStateRef.current = next
      dirtyRef.current = true
    })
  }, [store])

  const cols = Math.max(60, dims.cols)
  const rows = Math.max(16, dims.rows)
  const canSplit = cols >= 92
  const showEeg = eegOverride ?? canSplit
  const showChat = canSplit || !showEeg

  const runningCount = state.handoffs.filter((h) => h.status === 'running').length

  // Single coalesced ~10 FPS (100 ms) calm render loop: slow meditative 3D drift
  // (~22s/rev at rest, gently livelier when speaking/working), zero flicker.
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now()
      const current = latestStateRef.current
      const activeHandoffs = current.handoffs.some((h) => h.status === 'running')
      const activeAgents = current.agents.some((a) => a.status === 'running')
      const activeHeat = hasActiveBrainHeat(current.brain)
      const voiceActive = current.micLevel > 8 || current.athenaLevel > 5

      if (activeHeat) {
        store.dispatch({ type: 'brain-decay', now })
      }
      if (dirtyRef.current) {
        dirtyRef.current = false
        setState(latestStateRef.current)
      }
      if (showEeg) {
        const step = voiceActive || activeHandoffs || activeAgents ? 0.042 : 0.022
        setPhaseRad((p) => (p + step) % (Math.PI * 200))
      }
      if (activeHandoffs || activeAgents) {
        setTickNow(now)
        setSpinIdx((i) => (i + 1) % SPINNER_FRAMES.length)
      }
    }, 100)
    return () => clearInterval(timer)
  }, [showEeg, store])

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

  // Right pane vertical 50/50 split (strict AGENTS.md §1 row budget):
  // Top 50%: 3D Jarvis Holographic Sphere + compact 1-line Active Pathways readout
  // Bottom 50%: Running Agent Ledger (active agents pinned top, idle agents below)
  const rightTopRows = Math.max(8, Math.floor(middleRows / 2))
  const rightBottomRows = Math.max(5, middleRows - rightTopRows)
  const brainCanvasCols = Math.max(20, rightWidth - 4)
  const brainCanvasRows = Math.max(4, rightTopRows - 4) // border(2) + title(1) + pathways(1)
  const orbitalRows = useMemo(
    () =>
      showEeg
        ? renderBrainOrbitalLines(state.brain, brainCanvasCols, brainCanvasRows, {
            phaseRad,
            micEnergy: state.micLevel / 100,
            athenaEnergy: state.athenaLevel / 100,
          })
        : [],
    [showEeg, state.brain, brainCanvasCols, brainCanvasRows, phaseRad, state.micLevel, state.athenaLevel],
  )
  const hotNodes = useMemo(() => topFiringNodes(state.brain, 3), [state.brain])

  const ledgerContentRows = Math.max(2, rightBottomRows - 3) // border(2) + header(1)
  const activeAgents = useMemo(
    () => state.agents.filter((a) => a.status === 'running'),
    [state.agents],
  )
  const idleAgents = useMemo(
    () => state.agents.filter((a) => a.status !== 'running'),
    [state.agents],
  )
  const visibleLedgerRows = useMemo(() => {
    const ordered = [...activeAgents, ...idleAgents]
    if (ordered.length <= ledgerContentRows) {
      return { items: ordered, hiddenIdle: 0 }
    }
    const maxItems = Math.max(1, ledgerContentRows - 1)
    const items = ordered.slice(0, maxItems)
    const hiddenIdle = ordered.length - items.length
    return { items, hiddenIdle }
  }, [activeAgents, idleAgents, ledgerContentRows])

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

        {/* RIGHT PANE: 50% 3D Jarvis Sphere (top) + 50% Running Agent Ledger (bottom) */}
        {showEeg && (
          <Box flexDirection="column" width={rightWidth} height={middleRows} overflow="hidden">
            {/* TOP 50%: Calm 3D Jarvis Holographic Sphere */}
            <Box
              flexDirection="column"
              width={rightWidth}
              height={rightTopRows}
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

              {/* Compact 1-line Active Pathways readout */}
              <Box height={1} overflow="hidden">
                {hotNodes.length === 0 ? (
                  <Text dimColor wrap="truncate-end">
                    Core calm — speak or delegate to watch subsystems fire.
                  </Text>
                ) : (
                  <Text wrap="truncate-end">
                    {hotNodes.map((n, idx) => {
                      const pct = Math.round(n.heat * 100)
                      const bars = '█'.repeat(Math.max(1, Math.round(n.heat * 4)))
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
                )}
              </Box>
            </Box>

            {/* BOTTOM 50%: Running Agent Ledger (Active + Idle agents) */}
            <Box
              flexDirection="column"
              width={rightWidth}
              height={rightBottomRows}
              borderStyle="single"
              borderColor={activeAgents.length > 0 ? 'blueBright' : 'gray'}
              paddingX={1}
              overflow="hidden"
            >
              <Box justifyContent="space-between">
                <Text bold color={activeAgents.length > 0 ? 'blueBright' : 'white'}>
                  AGENT LEDGER
                </Text>
                <Text
                  bold={activeAgents.length > 0}
                  color={activeAgents.length > 0 ? 'blueBright' : undefined}
                  dimColor={activeAgents.length === 0}
                >
                  {activeAgents.length > 0
                    ? `${SPINNER_FRAMES[spinIdx]} ${activeAgents.length} ACTIVE · ${idleAgents.length} IDLE`
                    : `ALL IDLE (${idleAgents.length})`}
                </Text>
              </Box>

              {visibleLedgerRows.items.map((agent) => {
                const isRunning = agent.status === 'running'
                const elapsed =
                  isRunning && agent.startedAt !== null
                    ? formatHandoffElapsed(agent.startedAt, tickNow)
                    : agent.startedAt !== null && agent.finishedAt !== null
                      ? formatHandoffElapsed(agent.startedAt, agent.finishedAt)
                      : null
                const icon = isRunning
                  ? SPINNER_FRAMES[spinIdx]
                  : agent.lastStatus === 'completed'
                    ? '✓'
                    : agent.lastStatus === 'failed'
                      ? '✗'
                      : '○'
                const iconColor = isRunning
                  ? 'cyanBright'
                  : agent.lastStatus === 'completed'
                    ? 'green'
                    : agent.lastStatus === 'failed'
                      ? 'redBright'
                      : 'gray'
                const detail = isRunning
                  ? agent.task || 'Working…'
                  : agent.task
                    ? agent.task
                    : agent.description || 'Ready'
                return (
                  <Text key={agent.name} wrap="truncate-end">
                    <Text bold={isRunning} color={iconColor}>
                      {icon}{' '}
                    </Text>
                    <Text bold={isRunning} color={isRunning ? 'white' : undefined} dimColor={!isRunning}>
                      {agent.name}
                    </Text>
                    {elapsed && (
                      <Text dimColor={!isRunning} color={isRunning ? 'blueBright' : undefined}>
                        {' '}
                        [{elapsed}]
                      </Text>
                    )}
                    <Text dimColor> · {detail}</Text>
                  </Text>
                )
              })}
              {visibleLedgerRows.hiddenIdle > 0 && (
                <Text dimColor wrap="truncate-end">
                  +{visibleLedgerRows.hiddenIdle} more idle
                </Text>
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
