# Voice HUD, Live Connectivity & Harness Activation — 4-Phase Plan

**Date:** 2026-11-20
**Branch:** `feat/design-features-buildout`
**Parent:** [Fullscreen Split-Screen Voice HUD & 3D Brain Scan](voice-hud-brain-scan.md) | [Direct PCM & GPT-Live Voice Upgrade](gpt-live-voice-upgrade.md)

## Overview

Phased rollout to close the remaining `gpt-live-1.1` harness wiring gaps, activate Athena's Code Library (Project Librarian) and VMP Telemetry, and evolve the Voice HUD's right pane into a 50/50 split combining the calm 3D Jarvis hologram with a live **Running Agent Ledger** (active + idle agents).

---

## Phase 1 — Close Live-Voice & Environment Gaps (In Execution)

**Goal:** Bring `runLiveVoiceSession` (`gpt-live-1.1`) to full feature parity with the legacy voice path and clear the `athena doctor` dependency warning.

- **1.1 Environment sync:** Run `pnpm install --frozen-lockfile` so `node_modules` matches `pnpm-lock.yaml` (`athena doctor` `stale-deps` -> `[OK]`).
- **1.2 Wire `voiceTelemetry` into `runLiveVoiceSession`:** Pass `VoiceTelemetry` from `src/cli/voice.ts` into `src/voice/live-stream-session.ts` so `gpt-live-1.1` records closed-enum scalar lifecycle meters (`realtime.connect`, `session.ready`, `turn.submitted`, `turn.completed`, `turn.failed`) into `~/.athena/voice-usage.jsonl` with zero free text.
- **1.3 Wire `switchProject` into `runLiveVoiceSession`:** Pass `switchProject` from `src/cli/voice.ts` into `src/voice/live-stream-session.ts` so spoken project-switch delegations (`"switch project to <path>"`, `"open project <path>"`) rebuild `HarnessSessionController` at the target directory, carry bounded history, rebind `EngineEventBus` to `VoiceHud`, update the HUD header, and confirm via `session.commentary.append`.
- **Verification:** Unit tests in `tests/voice/live-stream-session.test.ts`, full native SOP gate (`typecheck`, `lint`, `test`, `build`), and clean `athena doctor`.

---

## Phase 2 — Enable Code Library (Project Librarian)

**Goal:** Activate the source-linked Project Librarian (`src/library/`) for trusted projects so Athena's `LibraryRead` / `LibraryWrite` tools and `Library` node on the 3D hologram go live.

- **2.1 Project trust check:** Confirm the target repo is trusted (`athena trust`).
- **2.2 Local opt-in config:** Create project-local `.athena/library.config.json` (gitignored via `.athena/`) with `enabled: true`, approved `publicSources` (e.g. `AGENTS.md`, `ARCHITECTURE.md`, `.wiki/` docs), explicit `categories`, and safe read-only verification `checks`.
- **2.3 Verification:** Confirm `LibraryRuntime.create(cwd, true)` initializes cleanly, `LibraryRead`/`LibraryWrite` mount on `HarnessSessionController`, and `athena doctor` stays green with zero tracked secrets or gitignored leaks.

---

## Phase 3 — Enable VMP Telemetry (Vibe Monitor Plus)

**Goal:** Activate local API usage/cost ledger recording (`~/.athena/vmp-ledger.jsonl`) so Athena's provider spend is tracked locally and ready for VMP polling.

- **3.1 Global opt-in:** Enable `vmp.enabled: true` in `~/.athena/settings.json` (preserving all existing model, permission, and deny settings).
- **3.2 Optional dashboard pairing:** Document and verify `athena vmp status`, `athena vmp report`, and (when a VMP collector URL + SHA-256 key hash are supplied) `athena vmp configure --url <url> --key-hash <sha256-hash>` + `athena vmp server`.
- **3.3 Invariant check:** Verify only scalar usage meters (tokens, retries, provider/model) are written — never prompts, completions, headers, or API keys.

---

## Phase 4 — Voice HUD 50/50 Right Pane: 3D Jarvis Sphere + Running Agent Ledger

**Goal:** Split the Voice HUD right pane vertically 50/50 so the calm 3D Jarvis hologram occupies the top half and a live **Running Agent Ledger** occupies the bottom half.

- **4.1 Strict fullscreen row budget (`AGENTS.md §1`):**
  - `rightTopRows = Math.floor(middleRows / 2)` -> 3D Jarvis Hologram (`renderBrainOrbitalLines`) + compact 1-line Active Pathways readout.
  - `rightBottomRows = middleRows - rightTopRows` -> **Running Agent Ledger** box (`borderStyle="single"`, `overflow="hidden"`).
- **4.2 Live Agent Ledger state (`src/voice/visualizer.ts`):**
  - Seed available/idle agents on startup from `activeController.orchestrator.listDefs()` (plus built-in `Athena Harness` / `Voice Duplex`).
  - Track live state transitions from `EngineEventBus` (`agent-status-update`, `tool-request`/`tool-result` for `Agent`, `background-status`, `handoff-start`/`handoff-end`):
    - **Active agents** (pinned top): animated spinner, agent name, current task/objective, elapsed `MM:SS` timer.
    - **Idle / Ready agents** (below): dimmed status dot `○`, agent name, concise role summary, last run timestamp/status if recently used.
- **4.3 Verification:** Render and row-budget tests in `tests/tui/voice-hud.test.tsx` (wide 50/50 split, narrow `Tab`/`B` toggle, overflow safety with many agents), full native SOP sweep, and `pnpm build`.
