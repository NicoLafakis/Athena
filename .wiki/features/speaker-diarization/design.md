# Speaker attribution - technical design

> [Overview](00-overview.md) | [Privacy](privacy.md) | [Acceptance/backlog](tasks.md)

All interfaces below are proposed, not present runtime APIs. Source audit baseline:
`4c379a057f07e5a001ecc66c5b6bc8ae40291038` (2026-10-06).

## Existing integration points

| Current source | Observed behavior | Proposed extension |
|---|---|---|
| [`src/voice/windows-speech.ts`](../../../src/voice/windows-speech.ts) | Windows wake recognition; WAV converted to 24 kHz PCM | Consented capture adapter with timestamps; separate 16 kHz model input branch |
| [`src/voice/daemon.ts`](../../../src/voice/daemon.ts) | Wake gate, playback suppression, Realtime reconnect, submission orchestration | Own attribution lifecycle without reopening ambient upload |
| [`src/voice/realtime.ts`](../../../src/voice/realtime.ts) | Raw 24 kHz audio adapter; bounded intent tools | Preserve provider contract; add a distinct timestamped ASR seam if selected |
| [`src/voice/schemas.ts`](../../../src/voice/schemas.ts) | Strict submission schema contains only bounded `text` | Add separately versioned internal attribution contracts; no extra fields smuggled into `submit_turn` |
| [`src/voice/turns.ts`](../../../src/voice/turns.ts) | In-memory dedupe by utterance plus normalized text | Carry attribution source IDs without creating another harness execution |
| [`src/voice/attention.ts`](../../../src/voice/attention.ts) | Canonical permission validation | Ignore name/profile/diarization scores for permission authority |
| [`src/harness/controller.ts`](../../../src/harness/controller.ts) | Shared authoritative harness session | Admit intentional final turns through existing controller |
| [`src/voice/telemetry.ts`](../../../src/voice/telemetry.ts) | Allowlisted counters without free text | Scalar latency/error counters only; no names, embeddings, PCM or transcript |

The present wake path emits utterance audio, not a continuous meeting stream or
word-timestamped ASR feed. Realtime intent text is not a verbatim transcript. Implement
and test a timestamped ASR adapter before promising word-level speaker attribution.
See [existing direct-harness specification](../blind-first-jarvis/direct-harness-voice.md).

## Data flow

```text
explicit participant consent + selected input mode
  -> capture frames / separate conferencing tracks + monotonic sample clock
       -> ASR (timestamped words, partial/final revisions)
       -> diarization (speaker activity intervals; mixed audio only)
  -> time alignment + overlap/unknown attribution
  -> optional local identity matching on clean segments
  -> speaker-tagged transcript + revisions + provenance
  -> mode-specific admission -> one Athena harness session
```

Resample the same source clock to each model's format; never align using wall-clock
arrival times. Preserve channel/track identifiers and sample offsets through resampling.
Attribution joins word intervals to speaker activity. Split words only if the ASR
supports it; otherwise mark ambiguous/overlap rather than fabricating exclusive speech.
Without reliable word times, publish segment attribution with reduced granularity.
Bound queues and working audio windows; overload emits a gap and degrades attribution,
never silently grows an unbounded PCM backlog. Assistant playback must not become a
participant or a command. Silence, noise and short fragments need an unknown outcome.

## Identity and lifecycle

- `harnessSessionId`: existing durable Athena conversation, survives provider renewal.
- `captureSessionId`: new random ID per explicitly started capture; never reused across
  independent conversations. `streamEpoch` increases on capture/worker state loss.
- `speakerId`: opaque session-local cluster, e.g. `spk-1`; scoped to capture and epoch.
  It is not a name, globally comparable identifier, or profile.
- `profileId`: random persistent local enrollment ID, used only while consent is active.
  Profile has display name, embedding/model revision, consent scope/version and expiry.
- `segmentId` + increasing `revision`: stable transcript source identity. Corrections
  replace attribution views; they do not rerun submitted work or rewrite history silently.

Retain diarizer state during an ASR/provider socket reconnect if capture continuity is
proven. Worker crash, lost samples, or uncertain cache continuity creates a new epoch,
announces a gap and resets labels. Never claim cross-epoch stability from model channel
numbers alone. If mapping clusters, require reviewed evidence, emit an explicit mapping
event and retain the original provenance. Late speakers, return after long silence, label
splits/merges and more speakers than capacity are required evaluation cases. Capacity
overflow becomes unknown/unsupported; do not force an extra person into a known label.

Identity matching uses clean non-overlapping evidence accumulated over a bounded window.
Require minimum usable duration, quality checks, absolute score threshold, top-two
margin, and hysteresis before suggesting a name. Thresholds are model/channel/domain
specific and fitted on held-out consented examples plus unenrolled impostors. Cosine
similarity and diarization activity scores are not calibrated identity probabilities.
Store score type, threshold/version and abstention reason; avoid a UI percent certainty
unless a separately validated calibration method supports it. Human name correction
does not train or enroll anyone automatically.

## Proposed worker and event contract v1

Local authenticated IPC exposes `start(config, consentSnapshot)`, `push(frame)`,
`flush()`, `stop(reason)`, `status()` and an event stream. Configuration pins worker/model
versions, sample format, speaker capacity, buffer limits and attribution policy. Readiness
requires a real backend probe in later implementation; optional failure never blocks
ordinary Athena. IPC is bounded, rejects unknown fields and disallows arbitrary paths.

Frame envelope: `{captureSessionId, streamEpoch, frameSeq, sampleStart, sampleCount,
sampleRate, channels, trackId?, pcm}`. PCM is in memory only, not an event-log field.

Events: `capture.started`, `capture.gap`, `speaker.observed`, `speaker.mapping`,
`transcript.segment`, `identity.suggestion`, `identity.revoked`, `capture.stopped`,
`worker.error`. Common envelope requires `schemaVersion`, opaque `eventId`, monotonic
`eventSeq`, capture/session/epoch IDs, `emittedAt`, `modelRevision` and `policyVersion`.
Transcript example (invented fixture, not observed audio):

```json
{
  "schemaVersion": 1,
  "type": "transcript.segment",
  "eventId": "evt-17",
  "eventSeq": 17,
  "captureSessionId": "cap-example",
  "harnessSessionId": "session-example",
  "streamEpoch": 1,
  "emittedAt": "2026-10-06T12:00:00Z",
  "modelRevision": "fixture-only",
  "policyVersion": "proposal-v1",
  "segmentId": "seg-4",
  "revision": 2,
  "startMs": 1200,
  "endMs": 2100,
  "text": "Please summarize this discussion.",
  "state": "final",
  "speakers": [{"speakerId": "spk-1", "source": "diarization"}],
  "overlap": false,
  "identity": {"status": "unknown", "reason": "not-enrolled"}
}
```

`state` is partial/final; `speakers` permits multiple labels or an empty unknown set.
`source` is track-metadata/diarization/human-correction, kept distinct. Optional word
intervals obey segment bounds. Identity is disabled/unknown/suggested/confirmed-by-human;
suggestions carry profile ID, score type/value and calibration version, never authority.
Validate bounded text (at most existing 4,096-character turn limit for admitted input),
IDs, arrays, finite numbers, time ordering and revision monotonicity. Oversize transcripts
need bounded chunks, not silent truncation of commands.

Use `(captureSessionId, streamEpoch, segmentId, revision)` for view dedupe; use the existing
utterance/turn ledger for execution dedupe. Partial text and late identity revisions cannot
execute work. A finalized meeting transcript remains observation until the operator
explicitly asks Athena to act. Voice command mode needs a dedicated admission rule for
ambiguous/overlapping command input; it must clarify rather than combine speakers.

Canonical session storage remains the single transcript source after persistence is
approved. Future [continuity](../conversational-continuity/00-overview.md) records reference
segment provenance and uncertain attribution; no duplicated biometric transcript archive.
