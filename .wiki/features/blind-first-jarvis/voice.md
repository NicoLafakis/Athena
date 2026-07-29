# Blind-first Jarvis upgrade - optional voice component

> [Objective overview](00-overview.md) | [Technical design](design.md) |
> [Implementation tasks](tasks.md)

## Role and authority

Voice is an opt-in adapter over Athena's semantic interaction contract. It offers
hands-free conversation from any window, but it is not the accessibility foundation and
it does not create a second account of current state. Every workflow remains complete by
keyboard and stable text when audio, wake word, network, or the Realtime provider fails.

The Realtime model is a conductor, not a coding agent. It can converse and invoke bounded
voice functions, but it never edits files or bypasses Athena's engine. Spoken status and
permissions are derived from `InteractionSnapshot` and `Announcement`.

## Architecture

```text
microphone -> local wake-word/PTT gate -> opt-in VoiceDaemon <-> Realtime API
                                           |
                                           v
                                     VoiceConductor
                           (delegate, status, focus, approve,
                                deny, cancel; no file tools)
                                           |
                                           v
                                      SessionRouter
                              /                         \
                     owned Engine session       local control client
                                                   to an Athena session

InteractionSnapshot + Announcement -> bounded spoken context -> VoiceConductor
```

`athena voice` is a separate entrypoint. Ordinary `athena` and `athena exec` boot paths
do not import, probe, or start voice dependencies.

## Session routing

Windows are display surfaces; sessions are the control surface. Resolution order is:

1. an explicitly selected session;
2. a foreground-window hint, when supported and proven;
3. the most recently active unambiguous session;
4. an audible request for clarification.

Athena states the destination before a consequential command. Ambiguity never silently
selects a session. Each session retains one writer; a later localhost named-pipe or socket
control channel makes the daemon a client of the owning process rather than a competing
engine writer.

## Voice permissions

The existing permission engine remains authoritative. An accessible request supplies the
conductor a bounded tool, target, consequence, reason, and stable request ID. The spoken
answer resolves that exact pending request. Consequential or ambiguous recognition
requires confirmation, and every request remains answerable from the keyboard. Voice
sessions default to scoped permissions, never implicit trust.

## Capability and privacy contract

`athena voice --probe` must round-trip sentinels through the selected microphone,
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

## Delivery sequence

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

## Implementation status (2026-07-29)

The provider-neutral core now lives in `src/voice/`. `buildVoiceContext` accepts only an
`InteractionSnapshot` and optional `Announcement`, then emits a strict bounded/redacted
context containing semantic objective, phase, pending attention, verified outcome, and
latest material announcement. No raw engine event, tool input/output, or independent
status digest enters the voice seam.

`VoiceSessionRouter` implements the canonical order: explicit session, proven foreground
hint, then an unambiguous recent session. Unknown or near-simultaneous candidates return
clarification rather than silently choosing. `VoiceSpeechOutput` consumes
`Announcement` only. Direct speech off is removable; exclusive ownership yields to an
active screen reader; supplemental ownership suppresses routine speech and allows only
blocking interruption when a screen reader is active.

Recognized text becomes an ordinary prompt or slash command, while recognition failure
is a no-op with a keyboard recovery message. Delegate/status/focus/approve/deny/cancel
calls are strict and ID-bound. Approve, deny, and cancel can never execute directly from
a conductor call: they create a bounded local confirmation request, and only a separate
exact `confirm` for its opaque ID releases the action.

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
`response.output_audio.delta`; function tools are declared on `session.tools`; and
push-to-talk interruption uses `response.cancel` plus playback stop and
`conversation.item.truncate`. Realtime sessions have a documented 60-minute maximum.
Athena therefore starts with push-to-talk, not always-listening or full-duplex behavior.

This resolves model and wire-schema selection only. No paid/live call was made, and
documentation is not a capability probe. The following release gates remain open:

- round-trip microphone and playback sentinels on each target machine;
- measured first-audio and interruption latency plus actual token/cost records;
- a selected local wake-word backend with an acceptable license, false-positive result,
  supervision behavior, and synthetic-audio probe;
- an authoritative retention/data-control determination for the selected account and
  endpoint;
- manual double-speech and focus testing with NVDA and Narrator enabled and disabled.

Ordinary Athena boot still imports none of `src/voice/`. No Realtime package, daemon,
audio backend, wake-word dependency, visible `athena voice` command, or credential prompt
has been added.
