# Blind-first Jarvis upgrade - optional voice component

> [Objective overview](00-overview.md) | [Technical design](design.md) |
> [Implementation tasks](tasks.md) |
> [Next upgrade: direct-harness voice](direct-harness-voice.md)

> **Next-phase authority:** The paid audio path below is proven, but the current
> conductor/delegation composition is an intermediate implementation. The
> [direct-harness voice specification](direct-harness-voice.md) defines the next upgrade:
> Realtime becomes an audio/intent adapter around one real Athena harness session.

## Role and authority

Voice is an opt-in adapter over Athena's semantic interaction contract. It offers
hands-free conversation from any window, but it is not the accessibility foundation and
it does not create a second account of current state. Every workflow remains complete by
keyboard and stable text when audio, wake word, network, or the Realtime provider fails.

In the working intermediate composition, the Realtime model is a conductor, not a coding
agent. It can converse and invoke bounded voice functions, but it never edits files or
bypasses Athena's engine. Its current `status` function reports only the latest voice
delegation result; canonical harness status and permissions are not yet wired into the
live CLI path. That wiring belongs to the direct-harness upgrade above.

## Current intermediate architecture

```text
microphone -> local Athena wake gate -> opt-in VoiceDaemon <-> Realtime API
                                           |
                                           v
                                     VoiceConductor
                         (delegate, status, confirm, cancel,
                              stop listening; no file tools)
                                           |
                                  separate confirm
                                           |
                                           v
                                resumable athena exec child
```

`athena voice` is a separate entrypoint. Ordinary `athena` and `athena exec` boot paths
do not import, probe, or start voice dependencies.

## Reusable session-routing seam

`VoiceSessionRouter` exists and implements this provider-neutral resolution order:

1. an explicitly selected session;
2. a foreground-window hint, when supported and proven;
3. the most recently active unambiguous session;
4. an audible request for clarification.

The working `athena voice` CLI does not currently use this router; it owns one resumable
child session after confirmation. The next upgrade instead makes voice own one harness
session directly. A later authenticated named-pipe or socket control channel may make
voice a client of an independently running TUI, but that IPC work is explicitly deferred.

## Voice permissions

The working conductor has no file or shell tools. It can only propose a bounded
delegation, and a separate later `Athena confirm` or keyboard `confirm` is required before
the resumable child engine runs it under Athena's existing permission and sandbox policy.
The current voice process does not yet announce or resolve canonical pending permission
records from that child.

The direct-harness upgrade must expose those records through stable permission IDs,
announce the exact bounded action and consequence, and allow voice or keyboard resolution
without treating model-authored confirmation as authority. Voice sessions default to
scoped permissions, never implicit trust.

## Capability and privacy contract

`athena voice probe` must round-trip sentinels through the selected microphone,
playback path, wake-word detector, Realtime connection, and any platform routing backend.
Executable or platform presence is not proof. Cache successful verdicts with enough
identity to invalidate them when the device/backend changes. Every failure names the
component, backend, and recovery command and leaves core Athena usable.

- Resolve the supported Realtime model, wire contract, pricing, and retention policy from
  current official documentation during the spike; do not freeze a draft model name.
- Keep API credentials per-machine through existing env/vault policy.
- Do not store voiceprints or raw recordings. Persist only redacted transcript/evidence
  needed by the normal session contract and an explicit cost/usage record.
- A wake-word sidecar is replaceable behind `WakeWordDetector`; its license, false-positive
  rate, synthetic-audio probe, supervision, and shutdown behavior are release gates.
- Start half-duplex or headphones-first. Full-duplex echo cancellation and barge-in wait
  for a proven audio backend.

## Historical delivery sequence

1. **Capability and cost spike:** probe the desktop and laptop audio paths, wake word,
   current API contract, latency, privacy, licensing, and failure reporting.
2. **Daemon-owned session:** PTT or VAD-gated conversation with delegate, status,
   permission, and cancellation functions over the semantic plane.
3. **Wake word and polish:** local gating, silence timeout, milestone speech, interruption
   policy, and spoken/logged usage summaries.
4. **Existing-session control:** opt-in local control endpoint, single-writer routing,
   foreground hint, and audible disambiguation.
5. **Optional duplex improvements:** only after measured demand and a proven echo-control
   path.

Tests use a fake Realtime server for protocol/tool calls, golden semantic streams for
spoken context, router ambiguity cases, exact permission IDs, cancellation races, cost
metering, and at least one platform-gated real subprocess/audio probe. Manual validation
runs with supported screen readers both enabled and disabled to catch double speech and
focus conflicts.

This sequence produced the working audio proof. Phase 7.6 now follows the separate
[direct-harness implementation sequence](direct-harness-voice.md#implementation-sequence),
which is authoritative for subsequent voice work.

## Implementation status (2026-07-29)

Provider-neutral building blocks live in `src/voice/`. `buildVoiceContext` accepts only an
`InteractionSnapshot` and optional `Announcement`, then emits a strict bounded/redacted
context containing semantic objective, phase, pending attention, verified outcome, and
latest material announcement. No raw engine event, tool input/output, or independent
status digest enters that context seam. The working CLI conductor does not yet consume
this context.

`VoiceSessionRouter` implements the planned order: explicit session, proven foreground
hint, then an unambiguous recent session. Unknown or near-simultaneous candidates return
clarification rather than silently choosing. It is not wired into the current CLI.
`VoiceSpeechOutput` consumes `Announcement` only and likewise remains a reusable semantic
output component rather than the current Marin playback path. Direct speech off is
removable; exclusive ownership yields to an active screen reader; supplemental ownership
suppresses routine speech and allows only blocking interruption when a screen reader is
active.

The provider-neutral input mapper can turn recognized text into an ordinary prompt or
slash command, while recognition failure is a no-op with a keyboard recovery message.
The working CLI instead uses the conductor's `delegate`, `status`, `confirm`, `cancel`,
and `stop_listening` calls. A delegation cannot execute from its proposal turn: only a
separate later confirmation releases it to the resumable child engine session.

### Working Windows composition

`athena voice` now dynamically loads the optional stack; ordinary `athena` and
`athena exec` do not load `ws`, probe speech, open the microphone, or contact OpenAI.
Windows `System.Speech` is now only a private wake gate. It loads a constrained grammar
for `Athena` and `Athena <dictation>` rather than using free-form Windows dictation to
decide the command. Once that grammar recognizes the wake phrase, Athena extracts the
associated microphone WAV, downmixes/resamples it in memory to 24 kHz mono PCM, and sends
the raw utterance to OpenAI Realtime. Windows' guessed command text is diagnostic only;
the Realtime audio model performs speech understanding. Ambient audio that does not pass
the local `Athena` gate stays on the machine. `athena voice --keyboard` drives the same
conductor and confirmation state machine with text input.

The default `gpt-realtime-2.1-mini` session uses an authenticated server-side WebSocket,
24 kHz PCM input, function calls, and 24 kHz PCM output. Laptop-array input enables the
provider's `far_field` noise reduction and uses explicit buffer append/commit events.
Output PCM is wrapped in a temporary
owner-only WAV for synchronous `System.Media.SoundPlayer` playback and deleted
immediately afterward; raw input audio, raw output audio, and voiceprints are not
persisted. The only voice-specific persistent telemetry is the provider's usage object,
model, and timestamp in `~/.athena/voice-usage.jsonl`.

The conductor exposes `delegate`, `status`, `confirm`, `cancel`, and `stop_listening`.
`delegate` records a bounded proposal and cannot run it. A model-produced confirmation
is valid only when the proposal existed before the current turn, so one utterance cannot
both propose and authorize work. A later `Athena confirm` invokes `athena exec` through the
existing engine with `acceptEdits`: file writes remain scoped to the workspace, while
shell and other consequential tools are not implicitly trusted. `Athena cancel` drops
the proposal. The first confirmed delegation creates a durable child session and later
delegations resume that same session. The bounded/redacted engine envelope is returned to
Realtime for a concise spoken summary; the model cannot manufacture the engine status.

`athena voice auth` accepts the OpenAI key with no character echo, validates a Realtime
session, then stores it under `voice/openai` in the per-machine OS vault and verifies
readback. `OPENAI_API_KEY` remains the zero-file override. A failed replacement attempts
to restore the prior working vault entry. `athena voice probe` audibly asks the user to
say `Athena voice probe`, allows three audible ten-second attempts, and verifies the
constrained local wake gate. It then sends that captured raw utterance to Realtime and
requires an actual spoken response and playback, proving microphone capture, format
conversion, provider speech understanding, and speaker output along the production path.
Diagnostics name the Windows default-input route, recognizer, and locally selected prompt
voice. Local prompts prefer an installed female Windows voice and fall back to the system
default; normal conversational output uses the Realtime `marin` voice. Every failure names
the recovery command and leaves core Athena untouched.

### Official Realtime contract resolved by the documentation spike

Official documentation checked on 2026-07-29 establishes two current candidates. The
quality baseline is [`gpt-realtime-2.1`](https://developers.openai.com/api/docs/models/gpt-realtime-2.1):
128k context, 32k maximum output, audio and text input/output, function calling, and no
structured outputs. Its published per-million-token prices are $4 text input, $0.40
cached text input, $24 text output, $32 audio input, $0.40 cached audio input, and $64
audio output. The cost-first candidate is
[`gpt-realtime-2.1-mini`](https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini),
with the same context/output limits and modalities at $0.60/$0.06/$2.40 for text and
$10/$0.30/$20 for audio. These are mutable published prices, not a session-cost promise;
Athena must record actual usage and expose a user budget.

The desktop CLI direction is a server-side WebSocket connection to
`wss://api.openai.com/v1/realtime?model=...` using the normal per-machine API key. The
official [WebSocket guide](https://developers.openai.com/api/docs/guides/realtime-websocket)
explicitly permits a standard API key for server-side clients. The current
[conversation contract](https://developers.openai.com/api/docs/guides/realtime-conversations)
uses `session.created`/`session.update`/`session.updated`; 24 kHz PCM is a documented
input option; streamed input uses `input_audio_buffer.append`, then `commit` and
`response.create` when VAD is disabled; audio arrives through
`response.output_audio.delta`; input can enable `far_field` noise reduction; function
tools are declared on `session.tools`; and
push-to-talk interruption uses `response.cancel` plus playback stop and
`conversation.item.truncate`. Realtime sessions have a documented 60-minute maximum.
Athena therefore starts with wake-gated, half-duplex turns rather than continuously
uploading room audio or attempting full-duplex echo cancellation.

The transport and local backend now exist, but automated tests do not make paid calls or
depend on a developer API key. Documentation and fakes are not a capability probe. Live
testing on Nico's machine found one installed recognizer and two voices; previous probe
runs captured speech from the default microphone and played local prompts. The constrained
wake grammar also loaded against the real default microphone and timed out cleanly on
silence. The raw microphone -> Realtime understanding -> Marin playback probe passed on
Nico's laptop on 2026-07-29. The following release gates remain open:

- round-trip the new wake-gated raw-audio probe on each target machine;
- measured first-audio and interruption latency plus actual token/cost records;
- measured constrained-wake false-positive and false-negative behavior in Nico's normal
  environment, with a dedicated wake-word sidecar if the Windows grammar is insufficient;
- an authoritative retention/data-control determination for the selected account and
  endpoint;
- manual double-speech and focus testing with NVDA and Narrator enabled and disabled.

The Windows backend is intentionally first, not a cross-platform support claim.
macOS/Linux audio backends, active-session control, foreground-window routing, duplex
echo cancellation, barge-in, and always-on background service behavior remain outside
this initial working path.
