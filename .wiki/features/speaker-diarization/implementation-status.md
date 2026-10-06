# Implementation status and next work

**Date:** 2026-10-06
**Branch:** `feat/speaker-attribution-contracts`
**Scope:** first synthetic Phase 0 slice; no audio/worker/storage integration

The paperwork in PR #9 is merged. Product decisions SD-001 are still pending. Starting
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

The provisional policy defaults are local processing, observation mode, no persistence
and no profile matching. Retention/expiry remain `null`; enabling those features requires
explicit configured periods. These defaults are engineering isolation, not Nico's final
product decisions. No hardware is presumed usable.

## Remaining task breakdown

| Next slice | Dependency / boundary | Completion evidence |
|---|---|---|
| SD-002 remainder: frame contract and worker lifecycle events | Pin sample/channel/PCM bounds; no backend needed | Malformed frames rejected; bounded IPC fixture tests |
| SD-003 remainder: owning service and accessible controls | Consent transition must cancel queued work and clear preview; trusted caller binds segment to active capture | Join/withdrawal races, stale-epoch admission, stop/error announcements tested |
| Admission integration | Pure helper's operator flag must come from trusted local control, never worker/model event; check current epoch/revision and existing turn ledger | No replay or double execution; observation transcript cannot auto-submit |
| SD-001 decision record | Nico chooses mode/ASR, devices, budgets, retention/expiry | Explicit configured decisions; no invented benchmark targets |
| SD-010/011/012 feasibility | Acquisition/environment approval and approved sources; no implicit WSL/system edits | License ledger, pinned versions, real hardware report |
| SD-020..023 anonymous live path | Actual participant consent and passing feasibility | Streaming, accessibility, privacy and latency acceptance |
| SD-030..032 optional profiles | Enrollment consent, expiry, protected storage design and calibrated evaluation | Deletion and held-out false-name tests |

## Important integration limits

These modules are dormant library primitives. `AttributionConsent` accepts consent supplied
by a future trusted participant UI; it does not prove identity or collect consent itself.
The future owner must clear buffers/preview when paused or stopped and bind admission to
the current capture epoch; this slice does not claim those effects already exist. Starting
a capture uses epoch 0; state loss requires an explicit gap before a higher epoch.
Provider-only reconnect does not create a new capture epoch.

Preview `capacity` is explicit overload rather than silent eviction. The owning service
must flush/stop or create an announced gap. Snapshot copies cannot mutate internal state.
Event IDs are audit identifiers; ordering/revision checks, not event-ID retention, provide
bounded replay handling. Identity revocation/mapping and word/frame schemas remain pending.
Human-confirmed identity is not accepted in the first schema until a separate trusted
correction/revocation interface is implemented.

No implementation PR is authorized for merge or deployment by the paperwork merge request.
