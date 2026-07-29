# Athena Voice Mode — Plan

Date: 2026-07-28
Status: Draft, pre-implementation

## Goal

Hands-free, window-independent voice interaction with Athena:

- A wake word ("hey athena") opens a live voice session powered by OpenAI's
  Realtime API (`gpt-realtime-2`).
- Back-and-forth conversation: Athena reports status **conversationally**
  (paraphrased, milestone-oriented), not by reading the transcript verbatim.
- The user speaks commands; Athena executes work through the existing engine.
- Works regardless of which window is focused. Design constraint: **pretend the
  user is blind.** A blind user cannot verify which window is active, so the
  design must never silently depend on a visual signal. Windows are display
  surfaces; *sessions* are the control surface.

## The key architectural insight

The "wrong window" problem dissolves once you stop targeting windows at all.
The thing being interacted with is an Athena **session**, not a terminal
window. Voice mode is a long-running **daemon** that:

1. owns its audio channel (wake word + Realtime session), and
2. routes commands to an Athena **engine session** — either one it owns, or one
   a TUI process has open, reached through a localhost control channel.

The foreground window becomes an optional *hint* for disambiguation, never a
load-bearing input. When resolution is ambiguous, the daemon asks out loud —
which is what a blind user's interface must do anyway.

## What already exists (verified against the codebase)

- The engine (`src/engine/`) has zero coupling to Ink. `EngineEventBus`
  (`src/engine/events.ts`) carries a complete event vocabulary (text deltas,
  tool lifecycle, todos, turn boundaries).
- Headless operation is proven: `athena exec` runs the engine without a TTY;
  evals drive it as a subprocess.
- Permissions are programmatic: `PermissionEngine.check()` → allow/deny/ask,
  and `EngineOptions.askUser` (`src/engine/loop.ts`) is an async callback any
  frontend can implement. The TUI is just one implementation.
- Sessions persist to JSONL with resume (`src/harness/sessions.ts`). Writes are
  lock-file protected and `Engine.runTurn` has a reentrancy guard — **one
  writer per session**. This shapes everything below.

## Architecture

```
 mic ──▶ wake-word detector (local, always on)
            │ "hey athena"
            ▼
      Voice Daemon  ──▶  OpenAI Realtime API (gpt-realtime-2, WebSocket)
      (athena voice) ◀──  audio out, transcripts, function calls
            │
            │ function tools: delegate_task, get_status, list_sessions,
            │                 focus_session, approve, deny, cancel
            ▼
      Session Router ──▶ owned Engine instance (phase 1)
                     └─▶ control socket into a running TUI process (phase 3)
```

### Two brains, deliberately

The Realtime model is a **voice conductor**, not a coder. It never touches
files. It converses, decides what the user wants, and calls function tools.
Athena's engine (Anthropic brain, tools, permissions, sessions) does the work.
The conductor only knows what we feed it — a rolling digest of bus events — so
it stays fast and conversational while Athena stays deep.

### Conversational status (not verbatim readback)

Engine bus events are compacted into short digests (turn started, tool ran,
tests red, permission pending, turn done) and injected into the Realtime
session as context items. The session instructions steer delivery: paraphrase,
speak at milestones, stay quiet during routine tool calls, interrupt only for
blockers and permission asks. "Conversational, not verbatim" is a prompting +
digest-format problem, not new infrastructure.

### Voice-driven permissions

Engine `askUser` → digest to the conductor → it asks aloud ("she wants to
write `loop.ts` — allow?") → user says yes/no → `approve`/`deny` tool call →
callback resolves. Default voice sessions to a scoped allowlist rather than
`trusted`; voice approval of diffs you cannot see is exactly the case the
allowlist exists for.

## Component decisions (researched)

### Realtime API — confirmed shape

- Model `gpt-realtime-2`, WebSocket `wss://api.openai.com/v1/realtime`,
  GA wire schema (Authorization header only; `session.type: "realtime"`;
  audio format as `{"type":"audio/pcm","rate":24000}`).
- Server-side VAD (`turn_detection: server_vad`) handles turn-taking;
  interruption/barge-in is built in.
- Function calling and mid-session context injection are first-class.
- `ws` becomes a new dependency; `OPENAI_API_KEY` via env or `athena auth`,
  per-machine (AGENTS.md rule 3).

### Wake word — research changed the plan

Picovoice Porcupine's free tier was discontinued 2026-06-30; the SDK stops
working without a paid enterprise key. **Porcupine is out.**

Plan: **openWakeWord** (open-source, Whisper-embedding-based, custom wake
words trainable) run as a small **Python sidecar process** the daemon spawns
and supervises. Fallback candidate: ViolaWake (open-source Porcupine-style
alternative). Either way the detector is behind a `WakeWordDetector`
interface so it can be swapped; cost control comes free because audio only
streams to OpenAI after detection, and a silence timeout returns the daemon
to wake-word-only mode.

This is the one new non-Node dependency. Per AGENTS.md rule 4, boot must
round-trip a probe (synthetic audio through the detector) and cache the
verdict — never infer from "python.exe exists."

### Audio I/O and the echo problem

- Capture/playback: `ffmpeg` subprocess (fits the repo's subprocess patterns)
  or `naudiodon` (PortAudio prebuilds for Windows). 24 kHz PCM16 mono to match
  the Realtime session; resample in-process if the device disagrees.
- **Full duplex over speakers has no cheap pure-Node AEC.** Options in order
  of pragmatism:
  1. Phase 1: headphones, or half-duplex ducking (mute mic while Athena
     speaks; loses barge-in, zero DSP).
  2. A USB speakerphone/mic with hardware AEC (moves the problem to silicon).
  3. LiveKit's SDK audio processing module (real AEC, heavy dependency).
  Barge-in is explicitly deferred past phase 1.

### Window/session resolution (the "active window" question)

- Foreground-window info is trivial when needed: `GetForegroundWindow` +
  `GetWindowTextW` + `GetWindowThreadProcessId` via `koffi` (no native build
  step). Used in phase 3 only, as a *hint* mapping the focused terminal to the
  Athena process it hosts.
- Resolution order: explicitly focused session (voice: "work with the refactor
  session") → foreground-window hint → most-recently-active session → **ask
  out loud**. Blind-user rule: never act on a session the user hasn't
  confirmed when more than one is plausible; always state which session a
  command will land in.

## Phasing

### Phase 0 — spike (prove capabilities, rule 4)
- `athena voice --probe`: round-trip test recording through capture → Realtime
  → playback; verify wake-word sidecar; print a doctor-style report.
- Deliverable: verified audio path on this desktop and the laptop, or a
  concrete list of what's missing.

### Phase 1 — conversational loop, daemon-owned session
- `athena voice` entry reusing the headless boot seams (same composition root
  as `exec`; likely extract `createRuntime()` from `cli.ts main()`).
- Daemon owns its own Engine + session. PTT or VAD-gated mic, headphones or
  ducking. Function tools: `delegate_task`, `get_status`, `approve`, `deny`,
  `cancel`.
- Works from any window because it touches no window.
- **This phase alone delivers most of the goal.**

### Phase 2 — wake word + conversational polish
- openWakeWord sidecar, silence-timeout return to listening mode.
- Digest format tuning and session instructions for milestone-style spoken
  updates; cost metering + spoken/logged usage summary.

### Phase 3 — drive the session in your active window
- Opt-in localhost control endpoint (named pipe on Windows) exposed by each
  Athena process (TUI or exec). The TUI remains the single writer — the
  daemon is just another client, the same shape the phone PWA would have used.
- Foreground-window hint + voice disambiguation. Commands spoken anywhere land
  in the session you're watching, and you see changes stream in that window.
- Optional: real AEC for speaker barge-in.

## Constraints carried from AGENTS.md

- Voice is strictly opt-in and additive: `athena` and `athena exec` boot paths
  unchanged; no voice code runs unless `athena voice` is invoked. Nothing here
  may become a boot precondition (rule 2).
- `OPENAI_API_KEY` per machine, env or vault, never committed (rule 3).
- Every platform capability (mic, playback, wake-word sidecar, koffi/user32)
  is proven by round-trip probe with a cached verdict (rule 4); at least one
  platform-gated test actually shells out.
- Gates before push: typecheck, lint, test, build (rule 6). Rebuild after pull
  on the other machine (rule 7).
- New mechanisms get wiki pages in the same commits that land them (rule 8);
  `.wiki/architecture/voice-mode.md` at phase 1.

## Testing strategy

- Realtime client: fake WebSocket server driving the GA event schema;
  assert session config, tool-call handling, digest injection.
- Session router: fake control endpoints; resolution-order and
  ambiguity-asks cases.
- Digest compactor: golden bus-event streams → expected digests (pure).
- Platform-gated: one test that actually captures/plays a second of audio,
  skipped off-Windows-CI per existing platform-test conventions.

## Open questions

- Wake word false-positive tolerance: "hey athena" is phonetically common in
  this household's vocabulary. May need a confirmation chime + short window,
  or a less collision-prone phrase.
- Cost ceiling: Realtime audio is per-minute; wake-word gating bounds it, but
  phase 2 should add a spoken/logged daily usage summary before it becomes a
  surprise.
- Whether the phase-3 control socket should be the same mechanism a future
  phone PWA uses (localhost WS vs named pipe). Probably yes — decide at
  phase 3, not now.
