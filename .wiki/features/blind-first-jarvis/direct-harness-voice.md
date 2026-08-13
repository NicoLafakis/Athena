# Direct-harness voice - next upgrade specification

**Tier:** 3 - CLI contract, microphone data, paid provider, permissions
**Date:** 2026-07-29
**Status:** Draft for implementation
**Parent:** [Blind-first Jarvis objective](00-overview.md)
**Related:** [Voice component](voice.md) | [Technical design](design.md) |
[Test strategy](test-strategy.md) | [Tasks](tasks.md) |
[ADR 0003](adr/0003-realtime-as-audio-adapter.md)

## Decision summary

The proven audio transport is retained, but the current Realtime conductor is not the
product boundary. `athena voice` must become a first-class presentation and input adapter
for one real Athena harness session.

OpenAI Realtime has two bounded responsibilities:

1. understand the user's post-wake audio and submit the intended turn to Athena; and
2. speak Athena's authoritative response with the Marin voice.

OpenAI must not answer repository questions independently, claim work happened, maintain
a competing task state, or decide whether Athena's tools may run. Athena's engine,
interaction state, permissions, trace, and session store remain authoritative.

## Why this upgrade exists

The current implementation proved the difficult external path:

- the Windows default microphone array captures speech;
- a local constrained `Athena` grammar gates ambient audio;
- captured speech is converted to 24 kHz mono PCM;
- `gpt-realtime-2.1-mini` understands that raw audio;
- OpenAI PCM output plays successfully with the Marin voice; and
- the API credential remains per-machine in the existing vault.

The live probe passed all of those checks on 2026-07-29. However, normal voice mode still
talks first to a lightweight Realtime conductor. That conductor may propose a delegation,
which is later executed by a spawned `athena exec` child. This feels like talking to an
assistant in front of Athena rather than talking to Athena herself.

The current wake listener also runs one blocking Windows recognition process at a time.
Each process times out and reopens the microphone, which explains the Windows microphone
privacy icon cycling even in silence. That is lifecycle churn, not evidence of microphone
sensitivity.

## Load-bearing invariant

> Every accepted spoken work turn is a normal input to exactly one Athena harness
> session, and every spoken claim about work or state is derived from that harness's
> authoritative result. Realtime is an audio/intent adapter, never a second agent.

An implementation that produces natural conversation but lets Realtime answer instead of
Athena, bypasses the harness permission engine, forks session truth, or invents status is
incorrect by construction.

## Target experience

### Startup

0. First run only: if no OpenAI voice key resolves from env or vault, `athena voice`
   asks for one inline — visible paste, provider validation, then a best-effort vault
   save. A failed save warns and keeps the session key; it never aborts startup.
1. The user runs `athena voice` once. Keyboard and screen-reader launch remain valid.
2. Athena opens one persistent local wake listener and one Realtime session.
3. Marin says a short readiness cue such as, "Athena is ready."
4. If OpenAI audio is unavailable, a local voice states the component and recovery
   command. Optional voice failure never prevents ordinary Athena from starting.

### Hands-free loop

1. Athena waits locally without uploading ambient room audio.
2. The user says, "Athena, inspect the failing tests and fix the problem."
3. The local wake gate releases only that utterance's audio to Realtime.
4. Realtime invokes one bounded `submit_turn` contract with the understood request.
5. The active Athena harness processes the request through its normal engine loop.
6. Existing tool permissions, sandboxing, hooks, traces, budgets, agents, and session
   persistence apply unchanged.
7. Athena's authoritative result is returned to Realtime for concise faithful speech.
8. Marin speaks the result; when playback ends, Athena automatically returns to local
   wake standby.

No keyboard action, push-to-talk button, or command re-entry is required after startup.
The wake phrase begins each turn. The first release remains half-duplex: the user waits
for Marin to finish before the next wake phrase.

### Permissions and interruptions

- A harness permission request is announced from the canonical permission record,
  including bounded action, consequence, and stable request identity.
- "Athena allow" and "Athena deny" resolve only the currently announced request. An
  ambiguous or stale answer changes nothing and asks for clarification.
- Keyboard permission response remains available at all times.
- "Athena repeat," "Athena status," and "Athena stop listening" are deterministic local
  controls backed by `InteractionService`; they do not require a model-authored status.
- Ctrl+C remains an immediate keyboard fallback. Full spoken barge-in while Marin is
  talking is deferred.

## Architecture

```text
                       pre-wake audio stays local
microphone -> persistent local Athena wake gate
                       |
                       v post-wake PCM only
                OpenAI Realtime audio/intent adapter
                       |
                 submit_turn(text)
                       |
                       v
              HarnessSessionController
          (one active Athena engine/session owner)
                       |
       +---------------+----------------+
       |               |                |
 permissions/hooks  tools/agents   InteractionService
       |               |          snapshot/announcements
       +---------------+----------------+
                       |
              authoritative turn result
                       |
                       v
             OpenAI Realtime -> Marin PCM
```

### Shared harness session controller

Factor the existing headless engine composition into a shared `HarnessSessionController`
used by `athena exec` and `athena voice`. Voice must not shell out to a new CLI process for
each task. The controller owns:

- one durable Athena session ID and engine lifecycle;
- normal prompt submission and abort handling;
- the canonical permission callback;
- semantic snapshots and announcements;
- bounded authoritative turn results; and
- clean shutdown without abandoning a child process or writer.

This is a refactor of the canonical harness path, not a second voice-only engine.

### Realtime contract

Replace the general conductor tools with a narrow adapter surface:

- `submit_turn({ text })`: submit one understood user request to the harness;
- `local_control({ action, request_id? })`: request a deterministic repeat, status,
  permission answer, or shutdown; local code validates whether it is currently legal.

The model instructions must require a tool call for every actionable user utterance. It
may clarify uncertain speech, but it may not independently answer the user's repository
or coding request. Tool results contain the bounded harness response that Marin may
summarize without changing factual status.

Input transcription, when enabled for diagnostics, is guidance only and is never the
authority on what the model heard. Raw post-wake audio remains the actual model input.

### Persistent Windows wake backend

Replace repeated blocking recognition subprocesses with one supervised long-lived
Windows process using continuous recognition. It must:

- open the default microphone once and keep it open while voice mode is active;
- load only the constrained local Athena wake grammar;
- emit bounded JSONL wake events and their in-memory recognized audio;
- recover from a backend crash with a bounded retry and one actionable spoken warning;
- stop promptly on abort/shutdown; and
- prove readiness by an actual microphone/recognizer round trip, never platform inference.

The Windows microphone privacy icon remaining on while `athena voice` is listening is
expected. Cycling without an explicit recovery event is a defect.

If measured false positives or false negatives remain unacceptable, introduce a
dedicated local wake-word sidecar behind the existing detector seam. Do not return to
free-form Windows dictation and do not stream pre-wake room audio to OpenAI.

### Speech output

Normal responses and the ready cue use Marin. Local Windows speech is limited to recovery
when the Realtime output path is unavailable. Realtime output is spoken from the harness
result, while critical deterministic announcements may be spoken directly from the
semantic plane when waiting for a model round trip would hide a blocker.

## Functional requirements

- **FR-001:** After `athena voice` reports ready, the complete common workflow is usable
  without a keyboard.
- **FR-002:** One persistent local listener detects `Athena` without periodic microphone
  close/reopen churn.
- **FR-003:** Ambient pre-wake audio never crosses the provider boundary.
- **FR-004:** Every non-control spoken request enters the canonical Athena harness as a
  normal prompt in one durable session.
- **FR-005:** Realtime never independently executes or claims harness work.
- **FR-006:** Harness permissions remain authoritative and are independently reachable by
  voice and keyboard.
- **FR-007:** Marin speaks authoritative harness results and Athena automatically resumes
  wake standby after playback.
- **FR-008:** Spoken status, repeat, and permission identity come from
  `InteractionSnapshot`, `Announcement`, and canonical permission records.
- **FR-009:** Voice failure is nonfatal, actionable, and does not damage the active session
  or stored credential.
- **FR-010:** Raw recordings and voiceprints are not persisted; usage/cost telemetry stays
  bounded and contains no secrets.
- **FR-011:** `athena voice --keyboard` exercises the same harness controller and permission
  path, changing only the input/output adapter.
- **FR-012:** A Realtime session renewal is transparent before the provider session limit;
  the Athena harness session and conversational objective survive it.

## Accessibility requirements

- A blind user hears ready, listening failure, permission, completion, failure, and
  recovery states without inspecting the terminal.
- Routine visual status is never the only account of state.
- Screen-reader ownership rules prevent Athena and the screen reader from reading the
  same routine message twice.
- Stable text remains available for Braille and review even when Marin speaks.
- Every voice-only action has keyboard parity; voice is not required for recovery.
- No essential response depends on recognizing color, animation, microphone icons, or
  transient terminal layout.

## Security, privacy, and integrity

- Reuse the existing per-machine OpenAI credential and vault policy.
- Bound and validate every Realtime tool argument before it reaches the harness.
- Treat model-produced `submit_turn` text as untrusted user input, never as permission or
  a trusted system instruction.
- Never map a conversational "yes" to a permission unless one exact request is pending
  and the response contract carries its stable identity.
- Keep the one-writer session invariant. A later controller for an already-running TUI
  must use authenticated local IPC rather than opening a competing engine writer.
- Persist normal redacted traces and provider usage only; never persist raw PCM by
  default.

## Data model and interface records

No database or destructive migration is required. Additive in-memory/Zod-validated
contracts should include a unique voice turn ID, source (`audio` or `keyboard`), bounded
submitted text, harness session ID, lifecycle state, and optional exact permission ID.
Only the existing redacted trace/session records and usage ledger are persisted. The turn
ID is the idempotency key that prevents a reconnect or repeated tool call from executing
the same harness request twice.

## Performance and cost budgets

- Ready cue after command launch: target p95 under 3 seconds on an already-authenticated
  machine, excluding explicit provider outage.
- End of user speech to first meaningful feedback: target p95 under 2.5 seconds, measured
  separately for harness work that continues in the background.
- Wake standby performs no paid model calls and uploads no audio.
- One spoken turn creates at most one user-audio submission plus the minimum speech needed
  to present harness results and required permission exchanges.
- Preserve the existing usage ledger; add turn type, model, and latency counters without
  transcript or secret values.

## Error behavior

| Failure | Required behavior |
|---|---|
| Wake backend cannot open microphone | Speak the component and `athena voice probe`; leave keyboard Athena usable |
| Wake backend crashes | Retry a bounded number of times, announce once, never busy-loop |
| Realtime disconnects | Preserve the harness session, reconnect/renew, then state whether the utterance must be repeated |
| `submit_turn` is malformed or duplicated | Reject it; never double-run the harness turn |
| Harness requests permission | Speak the canonical request and wait without fabricating progress |
| Speech playback fails | Print stable text and use local recovery speech if available |
| Session is ambiguous | Ask which session; never silently choose or create a competing writer |
| Shutdown occurs during work | Use the existing abort path and preserve trace/session evidence |

## Observability

- Record structured lifecycle counters for wake accepted/rejected, Realtime connect and
  renewal, turn submitted/completed/failed, permission wait/resolution, playback, and
  backend recovery.
- Correlate voice turn ID, Athena run/session ID, model, latency, and bounded provider
  usage without recording transcript values, raw PCM, secrets, or normalized file paths.
- The normal hash-chained trace remains the evidence for harness work; the voice usage
  ledger is cost telemetry, not a second activity history.
- Every optional-backend failure names the component, backend, and recovery command in
  stable text even when spoken recovery also succeeds.

## Rollout and rollback

The upgrade remains opt-in behind `athena voice`; ordinary boot never imports or probes
voice dependencies. Ship as independently green commits following the implementation
sequence. Keep `--keyboard` usable at every phase so the harness controller can be tested
without audio hardware.

Before the hands-free acceptance script passes, the current conductor path is a test
baseline, not a production fallback to preserve indefinitely. Rollback reverts the direct
bridge while retaining the already-proven credential, raw-audio transport, and probe.
Rollback must never delete an Athena session, credential, trace, or usage record.

## Implementation sequence

- [x] **1. Shared controller:** extract and regression-test `HarnessSessionController`
  from the existing CLI/headless composition. `athena exec` behavior must remain stable.
- [x] **2. Persistent wake process:** implement supervised continuous Windows recognition,
  JSONL framing, audio bounds, shutdown, and a real backend probe.
  Implemented 2026-08-12: one supervised `powershell.exe` process runs continuous
  `RecognizeAsync(Multiple)` recognition; phrase events are emitted as JSONL by a compiled
  C# sink (`Add-Type`) because scriptblock delegates never fire on the blocked main
  thread and `Register-ObjectEvent` module autoload can stall for tens of seconds. The
  Node side (`WindowsPersistentWakeInput`) gates on the ready round trip, bounds the
  queue, restarts a crashed listener three times with one warning each, and fails loudly
  with the `athena voice probe` recovery path. A win32-gated test drives the production
  script with a locally synthesized WAV sentinel — no microphone needed.
  Corrected 2026-08-13: `athena voice probe` was still calling the retired one-shot
  `recognizeWindowsPhrase`, so the command every wake failure names exercised a different
  backend than the one that failed — it could pass while the persistent listener was
  broken. `waitForWakeProbe` now builds a real `WindowsPersistentWakeInput` and awaits
  `next()` under a per-attempt deadline (`next()` waits forever by design), closes it on
  every path including timeout and throw, and reports the listener's own verdict through
  a new `onReady` seam plus the existing `onWarn`/`onListening` callbacks. A win32-gated
  test drives the probe through the real subprocess with the same WAV sentinel and
  asserts the child exits, so no orphan `powershell.exe` survives.
- [x] **3. Direct turn bridge:** replace `delegate` with `submit_turn`; route normal speech
  into the shared controller and return its authoritative result.
  Upgraded 2026-08-12 after live dogfood: `submit_turn` is now non-blocking — it returns
  at turn START (the Realtime response timeout would otherwise kill any harness turn
  longer than two minutes), the finished result arrives as a separate serialized spoken
  turn, and a busy harness answers "still working" instead of double-running. The session
  advertises only `submit_turn` + `local_control`, and its instructions put Athena in
  first person with her constitution woven in — the adapter-for-Athena wording produced
  third-person narration and unkept "I'll pass that along" promises. The shared text
  prompt and the voice prompt now make this unconditional: the agent identifies as
  Athena, owns actions and answers in the first person, and distinguishes source-code
  components only when discussing their implementation.
  Same-day conversational fix after live dogfood: a bare wake word is now answered
  LOCALLY (listening cue plus a ~6 s capture window) and never uploaded; the next phrase
  in the window is the command. The listener loads wake+dictation and free-dictation
  grammars, so a paused "Athena … <command>" works, not only fluid single utterances —
  previously the wake-only grammar completed first and the command never crossed the
  wire. A falling tone after each spoken reply marks the return to wake standby.
  Ambient non-wake phrases are still dropped on-device.
- [ ] **4. Voice permissions and controls:** connect canonical permission IDs plus local
  status/repeat/stop behavior with keyboard parity.
- [x] **5. Spoken lifecycle:** add Marin ready, waiting, permission, completion, failure,
  and recovery behavior under screen-reader ownership policy.
  Partial 2026-08-12: ready, work-started acknowledgment, asynchronous spoken completion,
  and failure reports are in. Permission announcements (item 4) remain open.
- [ ] **6. Session renewal and recovery:** reconnect Realtime without losing the Athena
  session; make duplicate submission impossible.
- [ ] **7. Automated verification:** protocol fakes, controller integration, microphone
  process supervision, confirmation races, duplicate prevention, redaction, and failure
  recovery.
- [ ] **8. Live blind-first validation:** complete the acceptance script below with screen
  reader off, NVDA on, and Narrator on; record latency and provider usage.
- [ ] **9. Gates and documentation:** reconcile this package, then run typecheck, lint,
  all tests, and build on the exact committed state.

## Acceptance script

The upgrade is not complete until all statements below are observed, not inferred:

- [ ] Launch `athena voice`; Marin audibly says Athena is ready.
- [ ] Leave it idle for more than two old timeout windows; the microphone backend does not
  cycle and no paid request is made.
- [ ] Without touching the keyboard, say, "Athena, tell me what repository you are in and
  summarize the current objective." The answer comes from the harness session.
- [ ] Ask Athena to inspect files and perform a safe read-only task; the normal harness
  trace contains the turn and tool evidence.
- [ ] Request a mutation; the canonical permission flow remains in force, and a stale,
  ambiguous, or same-turn confirmation cannot authorize it.
- [ ] Say "Athena status" during longer work; the response matches semantic runtime state
  rather than model-authored guesswork.
- [ ] Let Marin finish; Athena returns to wake standby without a keyboard action.
- [ ] Say "Athena stop listening"; the microphone closes, the process exits cleanly, and
  the durable Athena session remains resumable.
- [ ] Disconnect the network mid-session; Athena preserves harness state and gives an
  actionable spoken/text recovery path.
- [ ] Repeat the core journey with NVDA and Narrator; no critical state is missing and
  routine speech is not duplicated.

## Test strategy

- **Unit:** audio bounds, JSONL framing, wake confidence, Realtime tool validation,
  deduplication IDs, permission matching, result redaction, and session renewal state.
- **Integration:** fake Realtime socket -> `submit_turn` -> real shared controller with a
  deterministic model -> trace/result -> fake speech response.
- **Real subprocess:** continuous Windows recognizer readiness, sentinel transport,
  crash/restart, abort, and microphone release.
- **Regression:** existing `athena exec`, screen-reader, TUI, vault, permission, session,
  and optional-boot suites remain green.
- **Manual:** microphone/privacy behavior, natural wake phrases, Marin output, screen-reader
  ownership, latency, cost, and recovery from network/audio-device changes.

## Reuse - do not fork

The implementation must extend these authorities rather than clone them:

- engine/session composition and `EngineEventBus`;
- `InteractionService`, `InteractionSnapshot`, and `Announcement`;
- existing permission engine, IDs, sandbox, hooks, and trace writer;
- voice credential resolver and usage ledger;
- `VoiceSessionRouter`, confirmation schemas, and speech ownership policy; and
- the existing `athena exec` session persistence contract.

## Dependencies and estimate

The first implementation uses only existing dependencies: Node, Windows
`System.Speech`, OpenAI Realtime, Zod, the vault, and Athena's engine/interaction modules.
A dedicated wake-word dependency requires a separate measured need and approval.

Estimated implementation size: four to seven independently verifiable commits and
roughly 35,000-60,000 implementation tokens, with live hardware/AT validation between
the persistent-wake, direct-turn, and permission milestones.

## Explicit non-goals for this upgrade

- Operating-system autostart or an always-running background service.
- Full-duplex echo cancellation or spoken barge-in while Marin is playing.
- Controlling an independently running TUI through new IPC; preserve the seam for a later
  phase, but first make `athena voice` itself a direct harness owner.
- macOS/Linux audio backends.
- Voice cloning, impersonation, or persistent voiceprints/recordings.
- Continuous cloud listening before the local wake decision.

## Architectural decision record

Companion [ADR 0003](adr/0003-realtime-as-audio-adapter.md) records the load-bearing
decision: **Realtime is an audio/intent
adapter around a shared Athena harness controller, not a standalone conductor that
delegates to Athena.** Alternatives rejected:

| Alternative | Reason rejected |
|---|---|
| Keep the current conductor/delegate design | The user converses with a proxy; harness state and permissions are one step removed |
| Let Realtime be the coding agent | Duplicates Athena, bypasses its providers/tools/session policy, and creates competing truth |
| Stream the microphone continuously to OpenAI | Adds ambient privacy/cost exposure and is unnecessary for wake-to-talk |
| Spawn `athena exec` for every spoken task | Preserves a bridge rather than a live harness surface and complicates lifecycle/latency |
| Build active-TUI IPC first | Adds routing/auth/single-writer risk before proving the simpler voice-owned harness path |

## Open measurements, not blocking product questions

- Whether constrained continuous `System.Speech` meets acceptable wake false-positive and
  false-negative rates; measurement decides whether a dedicated local detector is needed.
- Whether output should stream to playback before `response.done`; measure first-audio
  latency before adding interruption complexity.
- The account-specific retention/data-control setting for the selected Realtime endpoint.

These measurements can change the backend or rollout, but not the load-bearing invariant.
