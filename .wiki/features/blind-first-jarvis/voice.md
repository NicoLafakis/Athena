# Blind-first Jarvis upgrade - optional voice component

> [Objective overview](00-overview.md) | [Technical design](design.md) |
> [Implementation tasks](tasks.md) |
> [Next upgrade: direct-harness voice](direct-harness-voice.md)

> **Authority:** The conductor/delegation composition described in earlier revisions of
> this page was removed on 2026-08-13. The
> [direct-harness voice specification](direct-harness-voice.md) is the authority for the
> shipped design: Realtime is an audio/intent adapter around one real Athena harness
> session.

## Role and authority

Voice is an opt-in adapter over Athena's semantic interaction contract. It offers
hands-free conversation from any window, but it is not the accessibility foundation and
it does not create a second account of current state. Every workflow remains complete by
keyboard and stable text when audio, wake word, network, or the Realtime provider fails.

The Realtime model is an audio/intent adapter, not a coding agent and not a conductor
standing in front of one. It understands post-wake audio, submits the understood request
to the harness, and speaks the harness's authoritative result in Athena's own first
person. It never edits files, never answers a repository question from its own knowledge,
and never decides whether a tool may run. Status, repeat, and permission identity are
served from `InteractionSnapshot`, `Announcement`, and canonical permission records, so a
spoken account of state is never model-authored guesswork.

## Architecture

```text
                       pre-wake audio stays local
microphone -> persistent local Athena wake gate
                       |
                       v post-wake PCM only
                OpenAI Realtime audio/intent adapter
                    (submit_turn, local_control)
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

`athena voice` is a separate entrypoint. Ordinary `athena` and `athena exec` boot paths
do not import, probe, or start voice dependencies.

## Reusable session-routing seam

`VoiceSessionRouter` exists and implements this provider-neutral resolution order:

1. an explicitly selected session;
2. a foreground-window hint, when supported and proven;
3. the most recently active unambiguous session;
4. an audible request for clarification.

`athena voice` owns one harness session directly and does not currently need the router;
it is retained for the deferred case where voice becomes a client of an independently
running TUI over an authenticated named-pipe or socket control channel. That IPC work
stays deferred: the single-writer invariant means a later controller must not open a
competing engine writer.

## Voice permissions

Permissions are canonical and voice cannot bypass them. The harness raises an ordinary
`ask` decision; `VoiceAttentionBridge` is the approver wired into
`HarnessSessionController`, and it is the single place where a spoken word can authorize
anything.

The request is spoken straight from the canonical accessible permission record — the same
`createAccessiblePermissionRequest` the screen-reader path uses — naming the tool, the
target, and the consequence. It is deliberately not routed through a model round trip:
that would both delay a blocker and license a paraphrase that changes what the user
believes they allowed.

### Context without authority

Speaking locally left the Realtime session blind: it was never told a decision existed, so
a user saying "allow" reached a model whose instructions correctly forbid inventing an
approval, and it narrated an explanation instead of calling `local_control`. Live dogfood
on 2026-08-13 walked straight into that loop.

The fix is context, never authority. Whenever the bridge announces, resolves, refuses, or
shutdown-denies a permission it emits a `VoicePermissionNotice`, and the session seeds it
into the live conversation as one bounded `system` item through
`conversation.item.create` — with **no** `response.create` behind it. An item on its own
never generates a reply
([Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations)),
so the model gains the identity and the fact of an outstanding decision for the turn the
user answers on, while the spoken blocker stays exactly what Athena said herself. Role
`system` (whose parts are `input_text`) is deliberate: `assistant` would assert Athena had
said it aloud and `user` would assert the user had — and one of those looks like consent.

Every invariant above still holds unchanged, because the notice touches none of them. It
is not a turn: it never rides the turn chain and never increments the Realtime turn
counter, so a same-turn answer is still refused and a legitimate later one still lands. It
authorizes nothing: only a validated `local_control` call reaching
`VoiceAttentionBridge.resolve` decides anything. And it is never load-bearing — a notice
that cannot be delivered leaves the permission spoken, answerable, and reported in stable
text, counted as `realtime.context/not-delivered`. A reconnect gets the same context
re-seeded through its session instructions, because a replacement conversation starts
empty and would otherwise reopen the same blind spot.

An answer is refused unless it identifies exactly one pending request:

- a **stale** identity (already decided), an **unknown** identity, or an **ambiguous**
  answer (no identity given while several are waiting) changes nothing and asks for
  clarification;
- an answer arriving on the **same Realtime turn** that raised the request is refused,
  because the user cannot have heard it yet;
- a conversational "yes" with nothing pending authorizes nothing;
- the model's `request_id` is Zod-bounded before it is matched — model output is untrusted
  input, never authorization.

Voice reaches `allow-once` and never `allow-always`: nothing in a spoken contract
distinguishes "yes to this" from "yes to all of these". The keyboard path still reaches
the wider answer, and typed answers resolve the same canonical request through the same
matcher with no model in the path (FR-006/FR-011). Shutdown denies everything outstanding,
because a harness turn parked on a decision nobody is left to give is a silent hang.

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
2. **Daemon-owned session:** PTT or VAD-gated conversation with work-submission, status,
   permission, and cancellation functions over the semantic plane. (The `delegate` tool
   this step originally named was replaced by `submit_turn` and then removed with the rest
   of the conductor.)
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

## Implementation status (2026-08-13)

Provider-neutral building blocks live in `src/voice/`. `buildVoiceContext` accepts only an
`InteractionSnapshot` and optional `Announcement`, then emits a strict bounded/redacted
context containing semantic objective, phase, pending attention, verified outcome, and
latest material announcement. No raw engine event, tool input/output, or independent
status digest enters that context seam. The live session serves `status` and `repeat` from
the same semantic sources rather than from this context object.

`VoiceSessionRouter` implements the planned order: explicit session, proven foreground
hint, then an unambiguous recent session. Unknown or near-simultaneous candidates return
clarification rather than silently choosing. It is retained for the deferred multi-session
case. The speech ownership rule is shared rather than re-derived per caller: direct speech
off is removable; exclusive ownership yields to an active screen reader; supplemental
ownership suppresses routine speech and allows only blocking interruption when a screen
reader is active. `athena voice` treats `off` as `supplemental`, because running it is
itself a request for spoken output and it is the one mode with no screen to fall back on.

The announcement plane is wired: the controller's `onAnnouncement` reaches the voice
session, which speaks under that ownership policy and always emits stable text for Braille
and review. Routine `polite` chatter stays stable-text-only, because Marin already narrates
the result of every turn and speaking both is noise rather than access. A permission is
never said twice: the plane's short line yields to the canonical record.

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
harness controller and the same permission path with text input, changing only the
input/output adapter (FR-011).

The listener is one supervised long-lived process, so the microphone opens once per
session rather than cycling per command. A fluid "Athena, <command>" ships its whole
utterance; a bare "Athena" is answered locally with a listening cue and a ~6 s capture
window, and the next phrase inside that window is the command. Neither the cue nor the
ambient audio before it crosses the provider boundary.

The default `gpt-realtime-2.1-mini` session uses an authenticated server-side WebSocket,
24 kHz PCM input, function calls, and 24 kHz PCM output. Laptop-array input enables the
provider's `far_field` noise reduction and uses explicit buffer append/commit events.
Output PCM is wrapped in a temporary
owner-only WAV for synchronous `System.Media.SoundPlayer` playback and deleted
immediately afterward; raw input audio, raw output audio, and voiceprints are not
persisted. Voice-specific persistent telemetry is the bounded lifecycle ledger at
`~/.athena/voice-usage.jsonl` described in [observability](observability.md).

The session advertises exactly two tools, `submit_turn` and `local_control`.

`submit_turn` routes one understood request into the shared `HarnessSessionController`.
It is deliberately non-blocking: it returns at turn START, because a harness turn can run
for minutes while the Realtime response holding the tool call times out at two minutes.
The finished result arrives later as a separate serialized spoken turn. A busy harness
answers "still working" rather than double-running. `VoiceTurnLedger` is the idempotency
key — scoped to (utterance, normalized text), so two calls inside one utterance run once
while the same words spoken again later are legitimately a new request.

`local_control` serves `status`, `repeat`, `allow`, `deny`, and `stop_listening`, all
validated by local code that decides whether the action is currently legal. `repeat`
replays what was actually said; `status` reports `waiting-permission` from the semantic
plane whenever a decision is outstanding.

The session instructions put Athena in the first person with her constitution woven in,
and forbid claiming an allow or deny that the tool result did not give.

`athena voice auth` accepts the OpenAI key with no character echo, validates a Realtime
session, then stores it under `voice/openai` in the per-machine OS vault and verifies
readback. `OPENAI_API_KEY` remains the zero-file override. A failed replacement attempts
to restore the prior working vault entry. `athena voice probe` audibly asks the user to
say `Athena voice probe`, then runs the wake stage against the **production**
`WindowsPersistentWakeInput` — process spawn, readiness round trip, JSONL framing,
`realtimePcmFromWave`, and the wake state machine — for three bounded twenty-second
attempts with a spoken retry cue between them. One listener per attempt, always closed
before the cue is spoken, so the listener cannot hear Athena say `Athena voice probe` and
pass itself. A failure names what the listener reported (readiness never proven, ready but
silent, wake word heard with no command, or restart budget exhausted) instead of only
"failed". It then sends that captured raw utterance to Realtime and
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
