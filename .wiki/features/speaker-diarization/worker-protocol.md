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
`transcript.segment` and `capture.gap` schemas are allowed. Every event carries
capture/harness IDs, owner epoch, monotonic sequence, model/policy provenance and
the other envelope fields. Event time never substitutes for source audio time.
No arbitrary prose, permission action, enrollment command or identity authority
is accepted. Strict ASR word/activity messages remain a subsequent adapter task.

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
inference latency result. Startup, idle heartbeat and inference deadlines still need
the future supervisor. Diagnostic codes are canonical; untrusted exception strings
are never rendered as consent notices. Port cleanup exceptions cannot prevent pause.

## Verification and remaining work

Synthetic tests cover split UTF-8/multiple messages, malformed/oversized input,
cross-session rejection, one pending frame, false-write/drain semantics, synchronous
and asynchronous completion, byte cleanup, deadlines, withdrawal/epoch changes,
fresh-channel restart and worker-error fencing within a callback.

Next: fake-process supervisor (timers, exit handling, startup probe), strict
ASR/activity event schemas and alignment adapter, trusted accessible local host
presentation, then acquired offline model adapters. See the
[acquisition proposal](backend-acquisition.md) and [implementation status](implementation-status.md).
