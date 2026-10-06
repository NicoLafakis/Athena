# Implementation status and next work

**Date:** 2026-10-06
**Branch:** `feat/speaker-alignment-controls` (follows merged PR #10)
**Scope:** synthetic Phase 0 contracts and owner; no audio device/worker/storage integration

The paperwork in PR #9 and synthetic owner in PR #10 are merged. Product decisions SD-001 are still pending. Starting
synthetic contracts does not approve hardware, retention, enrollment or acquisition.

## Implemented in this slice

- Strict `AttributionEventSchema` for transcript segments and gaps, including bounded
  IDs/text/speaker arrays, finite time/score validation, provenance and overlap rules.
- `AttributionPreview`: bounded in-memory revisions, monotonic event ordering, session
  isolation, explicit epoch gaps, stale replay refusal and copied snapshots.
- `AttributionConsent`: participant-specific capture/transfer/persistence/matching
  consent, explicit start/restart, pause on joining or withdrawal, and stop clearing consent.
- `attributedTurn`: pure explicit-admission filter emitting only existing `{text}`;
  partial/unknown/overlap and unconsented input cannot pass. Names never add authority.
- Synthetic fixtures for these boundaries. No boot/CLI/capture/controller wiring.
- Second slice: mono PCM16LE frame validation (16/24/48 kHz, at most one second),
  strict worker ready/error/stopped events, and `AttributionSession` owning consent,
  bounded frame queues, preview resets, pending-job aborts and current-segment admission
  through the injected existing `VoiceTurnLedger`. No worker subprocess is created.
- Third slice: strict ASR word/activity batches and conservative source-time alignment,
  preserving overlap and returning unknown on sequential speaker-boundary ambiguity.
  Track metadata precedes diarization; it remains account/track provenance, not identity.
- `AttributionLocalControls` provides strict participant disclosure/consent/join/withdraw,
  start/pause/stop/status/review and explicit submission. Deterministic text can feed the
  existing text/Braille/speech presentations; no model permission tools are added.

The provisional policy defaults are local processing, observation mode, no persistence
and no profile matching. Retention/expiry remain `null`; enabling those features requires
explicit configured periods. These defaults are engineering isolation, not Nico's final
product decisions. No hardware is presumed usable.

## Remaining task breakdown

| Next slice | Dependency / boundary | Completion evidence |
|---|---|---|
| SD-002 remainder: worker IPC transport, words/mapping/revocation | Frame and basic ready/error/stopped contracts now implemented; multitrack/resampling and additional events remain | Strict IPC/malformed payload and timestamp fixture tests |
| SD-003 remainder: host presentation integration | Strict trusted local control seam and deterministic accessible text implemented; no live participant consent UI yet | Wire returned text/notice codes to host text/speech with one output owner; verify real screen readers |
| Admission integration with live daemon/controller | Owner binds current epoch/revision and existing ledger; caller must supply monotonically allocated utterance IDs and explicit operator request | One production ledger/controller, no model-derived operator authority |
| SD-001 decision record | Nico chooses mode/ASR, devices, budgets, retention/expiry | Explicit configured decisions; no invented benchmark targets |
| SD-010/011/012 feasibility | Acquisition/environment approval and approved sources; no implicit WSL/system edits | License ledger, pinned versions, real hardware report |
| SD-020..023 anonymous live path | Actual participant consent and passing feasibility | Streaming, accessibility, privacy and latency acceptance |
| SD-030..032 optional profiles | Enrollment consent, expiry, protected storage design and calibrated evaluation | Deletion and held-out false-name tests |

## Important integration limits

These modules are dormant library primitives. `AttributionConsent` accepts consent supplied
by a future trusted participant UI; it does not prove identity or collect consent itself.
The synthetic owner now clears queued frames/preview on consent loss, aborts queued adapter
jobs and rejects old-epoch completion. A dequeued frame belongs to the future adapter,
which must release its own copies on abort; zeroing this queue is not a promise of physical
secure erasure. A callback ignoring abort remains counted until settlement so restarts
cannot create unlimited pending jobs. Adapter-owned memory is outside this queue's bound.

The standalone preview starts at epoch 0. The session owner announces disclosure/reset and
advances the epoch before worker readiness; callers read `status().epoch` when opening the
synthetic adapter. Only the owner advances epochs. Worker gaps/errors/stops invalidate
readiness and require a fresh ready event at the new epoch; worker events cannot invent
their own epoch. Provider-only reconnect does not reset the owner by itself.

Preview `capacity` is explicit overload rather than silent eviction. The owner clears its
preview/queue, aborts jobs and emits an overload notice on capacity. Snapshot copies cannot mutate internal state.
Event IDs are audit identifiers; ordering/revision checks, not event-ID retention, provide
bounded replay handling. Identity revocation/mapping remain pending.
Human-confirmed identity is not accepted in the first schema until a separate trusted
correction/revocation interface is implemented. The synthetic owner rejects all suggested
profiles and disallows cloud/persistent/profile policies until their adapters exist.

Owner notice codes are deterministic (`ready`, `waiting-consent`, `consent-paused`, `gap`,
`overload`, `worker-error`, `stopped`, etc.); no free-form worker error is announced.
`formatAttributionNotice` now maps these to stable plain language. The future host must
route it to the selected text/speech presentation. A broken
notice sink cannot prevent cleanup, but output-failure reporting belongs to that future
presentation. No real backend probe or accessible hardware acceptance is claimed.

`admit()` returns existing ledger admission, not harness execution. It checks current
stored segment/revision and explicit local intent, refuses partial/overlap/unknown input,
and marks admitted segments so later text revisions cannot run again. Caller-supplied
utterance numbers must come from the shared voice utterance allocator. The full daemon
must hand successful admission to its existing single controller and permission rails.

Alignment uses monotonic source milliseconds; `sampleIntervalToMs` converts absolute
source sample indices so equivalent resampled clocks align. Overlapping activity from
the same speaker is unioned, not double counted. Simultaneous distinct speakers produce
overlap; sequential distinct speakers inside one ASR word produce unknown. Single-speaker
coverage defaults to 0.8 and is configurable; this heuristic is not measured quality or
an identity probability. Intersecting track metadata suppresses biometric attribution,
including abstention if metadata coverage is inadequate. Shared accounts still need
individual consent. Batches have at most 256 ordered, nonoverlapping mono-ASR words,
2,048 activity intervals, eight labels and 4,096 transcript characters. Multi-track ASR
must normalize its source clocks and route tracks separately before this helper.

Local controls return stable review text with unknown/overlap/provenance, stripping
terminal control sequences through `plainBounded`. They are not model tools or worker
RPCs and do not authenticate participants. Calling submit requires a trusted human UI
and a shared utterance allocator. Pause retains consent but clears buffers/preview and
requires explicit restart plus new worker readiness; stop clears consent permanently for
that capture object. No production CLI or live consent collection is wired yet.

Read-only Helios inventory on 2026-10-06: NVIDIA RTX 5070 Ti Laptop GPU, 12,227 MiB VRAM
reported by `nvidia-smi`, driver 577.13; Python 3.12.10 installed. The inspected interpreter
has no torch, nemo, speechbrain, whisper, faster_whisper or soundfile packages. No model
compatibility/latency result is inferred; acquisition approval and ASR selection remain
pending. No dependencies or models were acquired for these slices.

Nico subsequently authorized merging scoped implementation PRs after exact-head clean CI.
This does not approve installation, acquisition, microphone capture, enrollment, new
credentials or system-file changes. Live implementation remains gated on those explicit
decisions and participant opt-in; the synthetic portions are not a finished live feature.
