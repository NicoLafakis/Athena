# Fullscreen Split-Screen Voice HUD & Live Neural Brain Scan

## Overview

When running `athena` (bare default) or `athena voice` on an interactive TTY (without `--keyboard`, `--tui`, or `--accessibility screen-reader`), `VoiceHud` (`src/tui/VoiceHud.tsx`) launches with `gpt-live-1.1` by default, enters the terminal's alternate screen buffer via `createFullscreenController()`, and renders a strictly row-budgeted fullscreen split-screen interface (use `athena tui` for the classic text TUI):

1. **Sticky Top Header** — Always pinned at the top: `ATHENA VOICE` status badge, active project and model, and compact dual live `YOU (MIC)` / `ATHENA (VOICE)` waveforms.
2. **Left Pane (~56% width) — Scrollable Conversation & Hand-Off Strip** — Retains up to 200 turns in a scrollable container (`PageUp`/`PageDown` to scroll, `Ctrl+PageUp`/`Ctrl+PageDown` to jump top/latest; obeys `AGENTS.md §5` platform limits). Pinned at the bottom of the left pane is the live `HAND-OFFS & BACKGROUND TASKS` strip with spinner and ticking `MM:SS.t` timer.
3. **Right Pane (~44% width, `cols >= 92`) — Live Orbital Neural "Brain Scan"** — High-resolution Unicode Braille (`0x2800`..`0x28FF`) orbital diagram of Athena's architecture (`SESSION CONTROLLER` core, `ENGINE`, `BRAIN`, `TRUTH PLANE`, `HARNESS`, `GUARDS`, `LIBRARIAN`, `JOURNAL`, `LEARNING`, `VOICE`).
   - Driven directly by live `activeController.bus` (`EngineEvent`) and `VoiceHudStore` events (`mic-level`, `athena-level`, `handoff-start`, `handoff-end`).
   - Firing nodes flash bright and illuminate synaptic arcs to the `SESSION CONTROLLER` core, then decay smoothly with an exponential EEG afterglow (stopping ticks automatically when all nodes cool to `0`).
4. **Sticky Footer (1 row)** — Scroll shortcuts, live firing count, and `Ctrl+C` exit.

On narrow terminals (`cols < 92`), the layout collapses cleanly to a single-column scrollable conversation + hand-off view without overflowing or corrupting frames.
