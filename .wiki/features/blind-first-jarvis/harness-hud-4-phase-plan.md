# Voice HUD, Live Connectivity & Harness Activation — 4-Phase Implementation Spec

**Date:** 2026-11-20
**Branch:** `feat/design-features-buildout`
**Status:** Phase 1 complete (`383bb3a`); Phases 2–4 specified and ready for execution
**Parents:**
- [Fullscreen Split-Screen Voice HUD & 3D Brain Scan](voice-hud-brain-scan.md)
- [Direct PCM & GPT-Live Voice Upgrade](gpt-live-voice-upgrade.md)
- [Source-Linked Project Librarian](../../architecture/librarian-library.md)
- [TUI Fullscreen Row Budget](../../architecture/tui-fullscreen-row-budget.md)

---

## Executive Summary

| Phase | Scope | Primary Files / Artifacts | Status |
|---|---|---|---|
| **Phase 1** | Close `gpt-live-1.1` harness wiring gaps (`switchProject`, `VoiceTelemetry`) & sync `node_modules` | `src/voice/live-stream-session.ts`, `src/cli/voice.ts`, `tests/voice/live-stream-session.test.ts` | **Done (`383bb3a`)** |
| **Phase 2** | Enable Code Library (Project Librarian) on trusted project | `.athena/library.config.json` (gitignored), tracked read-only check script if needed | **Planned** |
| **Phase 3** | Enable VMP Telemetry (Vibe Monitor Plus) local ledger + document remote pull pairing | `~/.athena/settings.json`, `~/.athena/vmp-ledger.jsonl` | **Planned** |
| **Phase 4** | Split Voice HUD right pane 50/50: calm 3D Jarvis Sphere (top) + live Running Agent Ledger (bottom) | `src/voice/visualizer.ts`, `src/tui/VoiceHud.tsx`, `src/cli/voice.ts`, `tests/tui/voice-hud.test.tsx` | **Planned** |

---

## Phase 1 — Close Live-Voice & Environment Gaps (Complete)

**Delivered in `383bb3a`:**
1. **Lockfile sync:** Executed `pnpm install --frozen-lockfile`; `athena doctor` `stale-deps` now reports `[OK]`.
2. **Scalar `VoiceTelemetry` on `gpt-live-1.1`:** Wired `VoiceTelemetry` (`~/.athena/voice-usage.jsonl`) from `src/cli/voice.ts` into `runLiveVoiceSession()` (`src/voice/live-stream-session.ts`), recording closed-enum scalar lifecycle events (`realtime.connect`, `session.ready`, `turn.submitted`, `turn.completed`, `turn.failed`) validated by `VoiceTelemetryRecordSchema` with zero free text.
3. **Voice-addressable `switchProject` on `gpt-live-1.1`:** Wired `switchProject` into `runLiveVoiceSession()`. Spoken project-switch delegations (`"switch project to <path>"`, `"open project <path>"`) rebuild `HarnessSessionController` at the target path, carry bounded history, rebind `EngineEventBus` to `VoiceHud`, update the HUD header, and return confirmation via `session.commentary.append`.
4. **Verified:** `tests/voice/live-stream-session.test.ts` (3/3), full native SOP sweep (178 test files), `pnpm build`, and `athena doctor`.

---

## Phase 2 — Enable Code Library (Project Librarian)

### Verified Architecture & Constraints (`src/library/config.ts`, `src/library/runtime.ts`, `.wiki/architecture/librarian-library.md`)
- `HarnessSessionController` automatically opens `LibraryRuntime.open(cwd, projectTrust.trusted)` at session startup when **both** conditions hold:
  1. The project path is trusted (`athena trust`).
  2. `<repo>/.athena/library.config.json` exists with `"enabled": true` and valid non-empty `publicSources`, `categories`, and `checks`.
- Because `.athena/` is gitignored (`AGENTS.md §3`), `.athena/library.config.json` and `.athena/library/library.json` stay strictly local to this machine and never enter git.
- **Hard policy invariants enforced by `LibraryConfigSchema` and `GitLibraryVerifier`:**
  - `publicSources`: Forward-slash relative paths to **git-tracked, public, UTF-8 files ≤ 64 KB** (no `.git`, `node_modules`, `.env*`, `credentials*`, `*.pem`, `*.key`, no secret/email/SSN patterns, no custom git clean filter).
  - `categories`: Lowercase `[a-z0-9][a-z0-9 -]{0,79}` (max 32).
  - `checks`: Each check has `{ id, args }` where **`args[0]` MUST be a git-tracked project JavaScript file** (`src/library/verifier.ts` binds a versioned `definitionHash` covering `id`, `args`, Node executable/version, `cwd`, and the canonical Git blob revision of `args[0]`).
  - **Child-agent exclusion:** `LibraryRead` and `LibraryWrite` mount on the parent `HarnessSessionController` only (read-only sandbox mounts `LibraryRead` only). Subagents explicitly receive neither tool.
  - **Operator CLI note:** `src/library/cli.ts` (`libraryCommand(cwd, operation, input)`) is implemented as a standalone module (`tsx src/library/cli.ts status`) and is not yet wired as a top-level `athena library` CLI subcommand. Adding a top-level `athena library status` route is optional and out of scope unless explicitly requested.

### Execution Steps
1. Verify project trust for `C:\programming\nicos-apps\Athena` (`athena trust` if not already trusted in the per-machine trust registry).
2. Confirm a tracked, safe, fast read-only Node `.js`/`.mjs` check script exists in the repo (or add a tiny tracked read-only check script if none matches `checks[].args[0]` requirements).
3. Create local gitignored `.athena/library.config.json` with:
   - `"enabled": true`
   - Curated `publicSources` (e.g., `AGENTS.md`, `ARCHITECTURE.md`, `.wiki/INDEX.md`, key `.wiki/architecture/*.md` and `.wiki/features/blind-first-jarvis/*.md` files — each verified ≤ 64 KB and free of sensitive patterns).
   - Clear `categories` (`architecture`, `voice`, `tui`, `security`, `harness`, `testing`).
   - Verified `checks` entry pointing to the tracked JS check script.

### Acceptance Gate
- `LibraryRuntime.open(cwd, true)` returns a live runtime (non-null) and `status().enabled === true`.
- `git status --short` remains completely clean (`.athena/library.config.json` stays untracked/ignored).
- `athena doctor` reports `[OK]` with zero errors.
- Existing `tests/library/*.test.ts` suites remain 100% green.

---

## Phase 3 — Enable VMP Telemetry (Vibe Monitor Plus)

### Verified Architecture & Constraints (`src/brain/settings.ts`, `src/harness/vmp.ts`, `src/engine/client.ts`, `src/engine/openai-client.ts`)
- **Provider coverage verified:** **Both** `AnthropicClient` (`src/engine/client.ts`) and `OpenAIClient` (`src/engine/openai-client.ts`) are already instrumented with `TelemetryRecorder` (`makeTelemetryRecorder(FileLedgerStore.forPaths(paths))`) across `src/cli.ts` and `src/cli/voice.ts`. Enabling VMP immediately records OpenAI (`sol-6.1`) and Anthropic turns alike.
- **Two activation levels:**
  1. **Local ledger recording (no external server required):** Setting `"vmp": { "enabled": true }` in `~/.athena/settings.json` activates `~/.athena/vmp-ledger.jsonl` immediately and enables `athena vmp status` and `athena vmp report`.
  2. **Remote VMP dashboard pull (`athena vmp server`):** Requires `reportUrl` + 64-char hex SHA-256 `keyHash` saved via `athena vmp configure --url <report-url> --key-hash <sha256-hash>`. Requests to `GET /api/vmp/report` are authenticated with `timingSafeEqual(sha256(BearerToken), keyHash)`; the raw connector key is never stored.
- **Ledger separation (important):**
  - Harness LLM calls (`OpenAIClient` / `AnthropicClient`) -> `~/.athena/vmp-ledger.jsonl` (VMP API Calculator format).
  - Live Voice WebSocket lifecycle meters (`gpt-live-1.1`) -> `~/.athena/voice-usage.jsonl` (Phase 1 `VoiceTelemetry`).
- **Privacy invariant (`AGENTS.md §8`):** Only normalized scalar meters (token counts, retries, model, provider, duration, status) are written. Prompts, completions, headers, and raw API keys never enter either ledger.

### Execution Steps
1. Update `~/.athena/settings.json` to add `"vmp": { "enabled": true }`, preserving all existing fields (`model`, `effort`, `permissionMode`, `sandboxMode`, `allow`, `deny`, `hooks`, `mcpServers`).
2. Verify `athena vmp status` reports `VMP connector: enabled` and `athena vmp report` outputs valid JSON schema.
3. If Nico supplies a VMP collector URL + SHA-256 key hash, run `athena vmp configure --url <url> --key-hash <hash>` to enable `athena vmp server`.

### Acceptance Gate
- `athena vmp status` -> `VMP connector: enabled`.
- `athena vmp report` -> valid JSON report with zero errors.
- `athena doctor` -> `[OK]` with zero settings validation warnings.

---

## Phase 4 — Voice HUD 50/50 Right Pane: 3D Jarvis Sphere + Running Agent Ledger

### Goal
Split the Voice HUD right pane vertically **50/50** so the calm 3D Jarvis Holographic Sphere occupies the top half and a live **Running Agent Ledger** (showing both **active** and **idle/available** agents) occupies the bottom half — obeying `AGENTS.md §1` strict fullscreen row budgeting with zero frame corruption.

### Verified Data Seams (Zero Changes Needed to `Engine` or `AgentOrchestrator`)
1. **Available / Idle agents (`activeController.orchestrator.listDefs()`):**
   - Returns all configured `AgentDef[]` (`name`, `description`) from `~/.athena/agents/`, `.athena/agents/`, and installed plugins.
   - Seeded into `VoiceHudStore` on startup and re-seeded after `switchProject` via a new `agents-sync` event (`{ type: 'agents-sync', agents: Array<{ name: string; description: string }> }`), alongside the built-in `Athena Harness` entry for delegated voice turns.
2. **Live Active / Idle transitions via `EngineEventBus` + `VoiceHudStore`:**
   - `handoff-start` / `handoff-end` -> marks `Athena Harness` as `running` (with live prompt + `startedAt`) and returns it to `idle` on completion (recording `lastStatus: 'completed' | 'failed'`, `lastFinishedAt`, `lastDetail`).
   - `tool-request` where `event.name === 'Agent'` (`src/tools/agent.ts`) -> extracts `input.agent` (or `action: 'followup'`/`'resume'` + `run_id`) and `input.prompt`, records `toolCallId`, and flips that agent entry to `running` with live task summary and `startedAt`.
   - `tool-result` where `event.name === 'Agent'` -> matches `toolCallId`, flips that agent back to `idle`, and records `lastStatus: event.isError ? 'failed' : 'completed'` and `lastFinishedAt`.
   - `agent-status-update` (`src/engine/types.ts`) -> updates the currently running agent's live `objective` / `nextExpected` string.
   - `background-status` -> surfaces active background task count in the ledger header without displacing agent rows.

### Strict Fullscreen Row Budget (`AGENTS.md §1`)
Inside `src/tui/VoiceHud.tsx` (`middleRows = Math.max(10, rows - HEADER_ROWS - FOOTER_ROWS)`):
- **Right pane vertical split (50/50):**
  - `rightTopRows = Math.max(8, Math.floor(middleRows / 2))` -> **3D Jarvis Sphere box** (`height={rightTopRows}`, `overflow="hidden"`):
    - Header: `NEURAL SCAN · EEG` + firing badge (1 row)
    - 3D Braille canvas: `brainCanvasRows = Math.max(4, rightTopRows - 4)` (border 2 + header 1 + compact 1-line `Active Pathways` 1)
    - Compact 1-line `Active Pathways` readout at bottom of top box
  - `rightBottomRows = Math.max(5, middleRows - rightTopRows)` -> **Running Agent Ledger box** (`height={rightBottomRows}`, `borderStyle="single"`, `overflow="hidden"`):
    - Header: `AGENT LEDGER` + live count (`1 ACTIVE · 4 IDLE` or `ALL IDLE (5)`) (1 row)
    - Content rows: `ledgerContentRows = Math.max(2, rightBottomRows - 3)` (border 2 + header 1)
    - **Row ordering:**
      1. **Active agents** pinned first: animated spinner (`⠋..⠏`), bold agent name, live elapsed `MM:SS`, and single-line truncated task/objective (`wrap="truncate-end"`).
      2. **Idle / Ready agents** below: dimmed `○`, agent name, and concise role or last-run badge (`✓ 00:04` / `✗ err` / truncated description).
      3. **Overflow safety:** If total agents exceed `ledgerContentRows`, reserve the last row for `+N more idle` so the box **never** overflows Yoga's fixed height.
- **Narrow terminals (`cols < 92`):**
  - Default: Chat only (`CONVERSATION` + `HAND-OFFS & TASKS`).
  - Press `Tab` or `B`: Full-pane 50/50 vertical stack of **3D Jarvis Sphere (top)** + **Running Agent Ledger (bottom)**.

### TDD & Verification Plan (Phase 4)
1. **`tests/voice/visualizer.test.ts`:**
   - Test `agents-sync` seeding idle agents, `tool-request`/`tool-result` (`name: 'Agent'`) flipping an agent `idle -> running -> idle` with elapsed time & status, `handoff-start`/`handoff-end` toggling `Athena Harness`, and `agent-status-update` updating the active objective.
2. **`tests/tui/voice-hud.test.tsx`:**
   - Wide terminal (`120x30`): assert `NEURAL SCAN · EEG` and `AGENT LEDGER` render together in the right pane; assert active agent shows spinner + task and idle agents show `○`; assert `Tab`/`B` hides and restores the right pane.
   - Narrow terminal (`80x26`): assert `Tab`/`B` reveals both `NEURAL SCAN · EEG` and `AGENT LEDGER`.
   - Overflow safety (`AGENTS.md §1`): 20-agent fixture on a 24-row terminal asserts exact height containment and visible `+N more` overflow line with zero frame corruption across every captured frame.
3. **Full native SOP sweep** (`typecheck`, `lint`, `test`, `build`) + `pnpm build` for global `athena` shim.
