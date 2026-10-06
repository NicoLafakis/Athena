# Consent, local storage and threat controls

> [Overview](00-overview.md) | [Design](design.md) | [Acceptance](tasks.md)

## Consent is a separate state machine

Capture, transcript persistence, cloud ASR transfer, evaluation recording and biometric
enrollment are separate opt-ins. Before input starts, disclose purpose, participants,
processing location, provider transfer, data retained, duration and deletion controls.
Record affirmative consent from each actual participant, including new arrivals; the
machine owner's consent cannot stand in for theirs. A shared track/account is not proof
that all people near its microphone opted in. If consent is unknown, stop/pause capture
for that source; mixed-room input requires pausing the whole input.

Proposed states: disabled -> disclosed -> capture-consented -> active -> paused/stopped.
Enrollment has its own disclosed -> enrollment-consented -> active -> expired/revoked
states. No implicit enrollment from a transcript name, a corrected label, a wake word,
or repeated conversations. Capture withdrawal stops processing and releases buffers;
profile withdrawal disables matching immediately and queues deletion of derivatives.
Offer keyboard and screen-reader controls and clear audible start/stop/pause indications.

No recordings or enrollment were authorized for this documentation task.

## Proposed storage defaults, subject to owner review

| Data | Location and default | Retention/deletion requirement |
|---|---|---|
| PCM and ASR/diarizer working buffers | Bounded worker memory; no raw recording | Release at stop, error, expiry or withdrawal; no debug dumps |
| Anonymous cluster/cache/ephemeral embeddings | Capture memory only | Reset per epoch/session; never enroll automatically |
| Enrolled embeddings + display name + consent record | Proposed per-user local brain area outside repo, e.g. `~/.athena/voice-profiles/`; disabled by default | Explicit owner-selected expiry required before enrollment; revoke and delete on request |
| Transcript attribution | In-memory preview; persistence separately opt-in | If enabled, canonical session source only; explicitly disclose existing session retention and choose policy before release |
| Metrics | Existing scalar-only voice ledger | No names/text/audio/embeddings; document metric rotation separately |

Profiles are sensitive biometric derivatives even without retained recordings. Use
restrictive per-user permissions and a verified OS-backed encryption design; don't
assume the credential vault already supports profile payloads. Atomic writes and
round-trip validation precede replacing any working artifact. Storage failure disables
enrollment/matching with an actionable warning, not ordinary Athena boot.

No git, VMP payloads, cross-machine sync, cloud backup or general model prompts contain
embeddings. Local profile IDs and names must be omitted from logs and provider context
unless the participant separately consents to named transcript disclosure. Restrict local
IPC to the active OS user; don't advertise a public inference service. Explicit model
acquisition may need network later; inference must be tested with outbound access denied
for a claimed local-only mode. Disable/verify dependency telemetry, including pyannote's
optional telemetry, before that claim. Existing Realtime sends post-wake audio externally;
using a local diarizer beside it does not change that fact.

Deletion must remove the profile, embeddings, samples if separately retained, caches,
pending match jobs and derived name mappings. Prevent in-flight results or index rebuild
from resurrecting a revoked profile. Provide a receipt naming data categories removed,
failures and retry steps without exposing biometric values. Transcript deletion is a
separate action: remove/tombstone linked attribution and future continuity derivatives.
Do not silently erase anonymous transcript content when only a profile is deleted.
Document backup/crash-dump limitations; do not promise physical secure erasure from SSDs
or copies outside Athena's control. No automatic age deletion is implemented by this doc.

## Threat model and invariants

| Threat | Required control |
|---|---|
| Replay, generated voice or wrong match | Advisory label only; existing permission gate remains authoritative |
| Spoken prompt injection from a bystander/meeting | Observation mode cannot submit work automatically; command admission stays explicit |
| Cross-session cluster reuse | Capture/epoch-scoped speaker IDs; no global inference from `spk-1` |
| Overlap contaminates enrollment | Reject overlapping/low-quality enrollment and match windows |
| Shared conferencing account mislabels a person | Preserve track/account provenance and permit unknown individual |
| Worker crash or stale IPC replay | Versioned IDs, gap/reset events, bounds and dedupe |
| Biometric/profile disclosure | Local permissions/encryption, no free-text telemetry, separate transfer consent |
| Revocation races and memory poisoning | Cancel pending matches, invalidate derivatives; no automatic named durable memory |

Identity matching never grants tool permission or raises trust. Keep existing same-turn,
stale, unknown and ambiguous permission refusals and prohibition on voice `allow-always`.
Even a human-confirmed name does not authenticate who is currently speaking. No test or
UI may market this as reliable speaker authentication.
