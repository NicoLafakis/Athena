# Fullscreen Split-Screen Voice HUD & Live Neural Brain Scan

## Overview

When running `athena` (bare default) or `athena voice` on an interactive TTY (without `--keyboard`, `--tui`, or `--accessibility screen-reader`), `VoiceHud` (`src/tui/VoiceHud.tsx`) launches with `gpt-live-1.1` by default, enters the terminal's alternate screen buffer via `createFullscreenController()`, and renders a strictly row-budgeted fullscreen split-screen interface (use `athena tui` for the classic text TUI):

1. **Sticky Top Header** — Always pinned at the top: `ATHENA VOICE` status badge, active project and model, and compact dual live `YOU (MIC)` / `ATHENA (VOICE)` waveforms.
2. **Left Pane (~56% width) — Scrollable Conversation & Hand-Off Strip** — Retains up to 200 turns in a scrollable container (`PageUp`/`PageDown` to scroll, `Ctrl+PageUp`/`Ctrl+PageDown` to jump top/latest; obeys `AGENTS.md §5` platform limits). Pinned at the bottom of the left pane is the live `HAND-OFFS & BACKGROUND TASKS` strip with spinner and ticking `MM:SS.t` timer.
3. **Right Pane (~44% width, `cols >= 92`, or full-pane via `Tab`/`B`) — 50/50 Split: 3D Jarvis Sphere (Top) + Running Agent Ledger (Bottom)**
   - **Top 50% (`NEURAL SCAN · EEG`):** High-resolution Unicode Braille (`0x2800`..`0x28FF`) calm 3D perspective-projected geodesic globe with 24-bit TrueColor RGB depth shading, Z-buffered occlusion, single golden equatorial halo, voice-reactive ripples, traveling 3D plasma synaptic pulses, and anchored plain-English subsystem labels (`Core`, `Voice`, `Thinking`, `Memory`, `Tools`, `Safety`, `Library`, `Journal`, `Learning`, `Verify`).
   - **Bottom 50% (`AGENT LEDGER`):** Live ledger of **active** (pinned top with spinner, elapsed `MM:SS`, and current task/objective) and **idle** agents seeded from `activeController.orchestrator.listDefs()` + `Athena Harness`, driven by `EngineEventBus` (`Agent` tool `tool-request`/`tool-result`, `agent-status-update`, `handoff-start`/`handoff-end`) with strict `AGENTS.md §1` row budgeting and `+N more idle` overflow handling.
   - Zero-flicker rendering: `VoiceHud` coalesces rapid audio/bus updates onto a single ~10 FPS animation clock, and `src/tui/sync-stdout.ts` brackets every TTY frame write in **DEC Mode 2026 Synchronized Output** (`\x1b[?2026h` ... `\x1b[?2026l`).
4. **Sticky Footer (1 row)** — Scroll shortcuts (`PgUp`/`PgDn`, `Ctrl+PgDn`), `Tab`/`B` EEG view toggle, view mode indicator (`EEG split` / `EEG full` / `Chat only`), and `Ctrl+C quit`.

On narrow terminals (`cols < 92`), the layout starts in single-column conversation view without overflowing or corrupting frames, and pressing `Tab` or `B` toggles full-pane EEG visualization without needing to resize the terminal or conflict with `Ctrl+C`. On wide terminals (`cols >= 92`), `Tab` or `B` toggles between split EEG and full-width chat-only view.
