# Dormant worker transport contract

`src/voice/attribution-ipc.ts` implements only an injected port and NDJSON codec.
No subprocess, model, microphone, host consent UI or production daemon is wired.
The next adapter must implement process lifecycle separately; no missing backend
may become a fatal Athena boot prerequisite.

## Host obligations

Create one channel per owner epoch. Preserve the single `AttributionSession` owner
and its authoritative capture/harness IDs. The worker never receives credentials or
consent authority. Start processing only through explicit local controls after actual
participant disclosure/consent; creating a channel does not provide that consent.

`sendNext()` consumes a copied owner frame only when the owner is active. It emits
one UTF-8 JSON line containing the validated mono PCM16LE frame fields, with `pcm`
encoded as base64. At most one serialized write remains pending in the channel.
The port's `write(bytes, complete)` follows stream semantics: returning `false`
means accepted with backpressure, not failed. Do not resend. Call `complete` only
when the underlying writer releases the bytes; the channel zeros that buffer.
Call `drain()` on the stream drain signal before pumping again. There is no implicit
recursive pumping or unbounded channel queue; the existing owner bounds unsent frames.

The host must schedule `checkDeadline()` during idle periods, and call `close()`
immediately on pause, withdrawal, stop, process exit or host shutdown. Merely changing
the owner epoch does not synchronously notify this dormant channel: its next operation
detects that epoch and closes it. Immediate revocation must therefore be connected
by the host adapter. Zeroing owned buffers cannot erase copies already held by a
worker; terminate the worker and its buffers too. Explicit restart requires a new
channel, current-epoch readiness and local start; no automatic consent restart.

## Worker output

Only existing strict `worker.ready`, `worker.error`, `worker.stopped`,
`worker.heartbeat`, `worker.word`, `transcript.segment` and `capture.gap` schemas are allowed. Every event carries
capture/harness IDs, owner epoch, monotonic sequence, model/policy provenance and
the other envelope fields. Event time never substitutes for source audio time.
No arbitrary prose, permission action, enrollment command or identity authority
is accepted. `worker.word` contains `segmentId`, `revision`, `state`, and `alignment`
with the matching capture/epoch, exactly one ASR word, and source-time activity
intervals. The existing alignment input bounds and conservative 0.8 timing-coverage
heuristic apply; this is not a probability. One word becomes one preview event,
retaining its envelope sequence. Stable word segment IDs/revisions belong to the
worker adapter; corrections may revise final words but cannot turn them partial again.
Workers may claim only diarization activity here; participant-track metadata requires
the trusted host path. Silence/insufficient coverage/boundaries remain unknown and
simultaneous activity remains overlap. Names stay unknown.

Heartbeat messages require existing readiness, matching scope and a new sequence.
They sustain the idle lease during silence without creating transcript segments.
Rejected/stale output does not extend the lease or establish readiness.

Pass stdout only to `receive()`. Keep stderr separate and redact/limit it before any
diagnostic presentation. Each receive callback is bounded to 65,536 bytes; each
NDJSON line is bounded to 262,144 bytes (configurable downward, minimum 1,024).
The host stream reader must split larger chunks. Partial UTF-8 stays buffered until
newline; complete lines use fatal UTF-8 decoding and JSON/schema validation. Blank,
malformed, oversized or unknown messages close the port and pause the owner.
Cross-session/stale envelopes are refused by the owner and cannot establish readiness.

Port write failures and the default 5-second pending-write deadline pause processing,
clear queued audio/preview via the owner, zero channel buffers and close the port.
The deadline is configurable within 1–60,000 ms; it is a transport guard, not an
inference latency result. Startup and heartbeat/idle deadlines are handled by the
injected supervisor below; model-specific inference deadlines need the acquired
backend adapter. Diagnostic codes are canonical; untrusted exception strings
are never rendered as consent notices. Port cleanup exceptions cannot prevent pause.

## Verification and remaining work

Synthetic tests cover split UTF-8/multiple messages, malformed/oversized input,
cross-session rejection, one pending frame, false-write/drain semantics, synchronous
and asynchronous completion, byte cleanup, deadlines, withdrawal/epoch changes,
fresh-channel restart and worker-error fencing within a callback.

## Supervision and trusted host adapters

`AttributionWorkerSupervisor` takes a local process factory with data/exit subscriptions,
a write/close port and `kill(): Promise<void>` that resolves only on confirmed exit.
It creates no concrete process itself. Only explicit trusted start after consent
invokes the factory. Host scheduling must call `tick()` during idle periods (no timer
is implicitly created). Default startup is 5 seconds; connected idle is 30 seconds,
configurable within 1–120,000 ms. These are provisional transport limits, not measured
inference targets. Accepted readiness/word/transcript/heartbeat output renews the idle
lease. Failures retire the channel, pause the owner and request process termination;
there is no automatic retry. Retired-generation callbacks are fenced. A pending or
failed exit blocks replacement workers, keeping even noncooperative cleanup bounded.

`AttributionLocalHost` uses the existing `InteractivePresentation` detail/prompt seam.
It has one supervisory diagnostic sink, no separate TTS owner, and no worker/model
entrypoint. Controls immediately revoke the supervisor when the owner epoch changes.
The consent prompt withdraws prior assent, discloses local/ephemeral use, and accepts
only `I CONSENT <participantId>` for that participant. Every other answer declines;
cancellation/failure/stale epoch records no fallback assent. Start is separate.
The host must establish that the actual participant is answering; the typed ID itself
does not authenticate anyone. UI output failure cannot prevent cleanup. `close()`
stops the owner/worker and releases the diagnostic sink. None of this is registered
in production boot, CLI, microphone capture or the voice daemon.

Completed synthetic work covers process launch failures, startup/idle deadlines,
heartbeat freshness, explicit restart after confirmed exit, failed cleanup, stale
callbacks, source frame-to-word-to-preview, and consent through the real existing
screen-reader presentation with fake input. No real screen reader or participant
acceptance is claimed. Next work depends on an approved backend entrypoint and actual
participant consent: concrete process/timer wiring, audio frontend, offline model
adapters and live accessibility/performance acceptance. See the
[acquisition proposal](backend-acquisition.md) and [implementation status](implementation-status.md).
