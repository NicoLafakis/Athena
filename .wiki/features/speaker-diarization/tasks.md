# Implementation backlog and acceptance gates

> [Overview](00-overview.md) | [Design](design.md) | [Privacy](privacy.md) | [Research](research.md)

Phase 0 is in progress; see [implementation status and remaining slices](implementation-status.md).
No complete phase or live capability is claimed. Dependencies run in order; persistent matching is optional and
must not delay a useful anonymous-only release. Runtime implementation must follow
`AGENTS.md` exact staged-tree typecheck/lint/test/build and topic-branch CI requirements.

SD-002 now includes transcript/gap, frame and basic worker lifecycle contracts with an
ephemeral owner. SD-003 includes synthetic consent loss, frame/job cleanup and admission
tests. Word-timestamp alignment and stable accessible local control text are implemented;
trusted host presentation and fake-process supervision now have synthetic adapters.
Actual worker/backend acquisition, production composition and participant acceptance
remain pending; see [implementation status](implementation-status.md).

## Phase 0 - product decisions and synthetic contracts

- [ ] SD-001: Nico chooses input/ASR mode, target speakers/devices/languages, deployment
  environment, retention/expiry and numeric release budgets. Owner: Nico + implementer.
- [ ] SD-002: Add strict versioned frame/event schemas, fixture reducer and revision/gap
  semantics from the design. No microphone or model required. Owner: implementer.
- [ ] SD-003: Implement consent-state tests, observation versus command admission, and
  accessible start/stop/error controls. Unknown consent must block capture.

**Exit:** approved decision record; schema fixtures cover malformed, late, duplicate,
unknown and overlapping events; no attribution field can affect permission outcomes.

## Phase 1 - approved acquisition and Helios feasibility

- [ ] SD-010: Audit separate code/weight licenses and dependency gates; obtain explicit
  approval before model downloads, installs or environment/system changes.
- [ ] SD-011: Inventory hardware and probe the chosen local worker. Pin versions and
  record reproducible configuration; stop on incompatible acceleration/OS rather than
  installing WSL or modifying system configuration implicitly.
- [ ] SD-012: Evaluate timestamped ASR plus diarization on permitted offline fixtures;
  compare GPU candidate and CPU prototype, then select using measured budgets.

**Exit:** reproducible measured feasibility report, notices ledger and working bounded
local IPC. Local-only claim must pass an outbound-network-denial test. No speaker profiles.

## Phase 2 - anonymous live attribution

- [ ] SD-020: After participant opt-in, wire capture -> ASR/diarization -> transcript
  alignment -> accessible preview. Validate separate-track precedence.
- [ ] SD-021: Add speaker/epoch lifecycle, gaps, overlap and unsupported-capacity behavior;
  preserve labels on provider-only reconnect; reset visibly after state loss.
- [ ] SD-022: Connect finalized intentional turns to the existing single controller and
  turn ledger. Meeting observations cannot run commands. Preserve all permission rails.
- [ ] SD-023: Implement stop/withdrawal, bounded teardown and approved transcript retention.

**Exit:** tests below pass and anonymous attribution meets owner-approved thresholds.
Ordinary Athena and existing voice mode remain usable with worker missing or failed.

## Phase 3 - optional consented profiles

- [ ] SD-030: Separate enrollment consent and quality checks; no overlap or passive
  enrollment. Verify local protected storage and profile expiry/revocation/deletion.
- [ ] SD-031: ECAPA scoring, unknown rejection and hysteresis; calibrate thresholds/margins
  on held-out genuine/impostor data across approved microphones/noise conditions.
- [ ] SD-032: Review/correct suggestions and show provenance; deletion invalidates pending
  jobs and derived mappings. Test no silent durable memory or provider disclosure.

**Exit:** false-name budget and deletion/consent tests pass. If not, retain anonymous
release; never lower rejection thresholds just to produce more names.

## Phase 4 - opt-in rollout

- [ ] SD-040: Independent human review of transcript/label errors and accessible controls.
- [ ] SD-041: Publish real hardware latency/quality/cost report, known limits and recovery
  guide; run repository gates and all CI matrix jobs before merge of runtime changes.
- [ ] SD-042: Opt-in dogfood, bounded metrics and rollback switch; no default microphone
  start, automatic enrollment or mandatory boot dependency.

## Acceptance tests

| ID | Scenario and pass condition |
|---|---|
| AT-01 | Unconsented participant/new arrival: no capture proceeds; withdrawal stops buffers and pending work |
| AT-02 | Two similar voices, short speech, noise, silence, unenrolled speaker: abstain when evidence is inadequate; no fabricated name |
| AT-03 | Simultaneous speakers: preserve overlap/multiple labels; no mixed enrollment or merged command |
| AT-04 | Late speaker, long silence/return, cluster split/merge, capacity+1: explicit corrections or unknown; no forced attribution |
| AT-05 | Resampling and timestamp drift: fixture words align to known sample-clock intervals within agreed tolerance |
| AT-06 | Provider reconnect, worker restart, dropped frames: no duplicate harness execution; stable labels only with intact state; explicit new epoch/gap otherwise |
| AT-07 | Replayed audio or perfect profile match asks for permission: same canonical refusal/validation behavior as unmatched audio; never grants trust or allow-always |
| AT-08 | Partial/final/late revisions and repeated events: one transcript view and at most one admitted turn; repeated words in a later intentional utterance remain a new turn |
| AT-09 | Profile revocation/deletion while matching: no stale suggestion; rebuild cannot restore names; deletion receipt lists failed categories |
| AT-10 | Outbound access denied and logs inspected: local mode works; no audio, embeddings, names or transcript in metrics/debug logs |
| AT-11 | Missing/crashed worker, corrupt profile store, queue overload: actionable accessible warning; normal Athena boots; bounded memory and clean teardown |
| AT-12 | Shared conference mic/account: account/track provenance distinct from individual identity; no assumed individual consent |
| AT-13 | Assistant playback and meeting prompt injection: neither becomes a command; observations require operator admission |
| AT-14 | NVDA/Narrator/keyboard review: start/stop, unknown, overlap, correction and failure understandable without visual-only state |

## Go/no-go record

Before measurements, approve numeric values for: end-of-speech to usable attributed text
p95/p99, sustained real-time factor and queue ceiling, memory ceiling, DER/scoring
convention, word-attribution error, label churn, false named matches, false rejects and
minimum held-out sample coverage. The existing direct-voice feedback budget is context,
not evidence that this new pipeline meets it. Thresholds are currently **TBD**.

GO requires consent/privacy/permission tests with zero known violations, budget-compliant
measurements on supported hardware, reviewed license obligations, clear recovery, and
owner acceptance. Any unapproved numeric budget, failed deletion, hidden upload,
identity-driven permission, unbounded queues or unresolved state-loss attribution is
NO-GO. Identity quality failure blocks matching, not a separately passing anonymous mode.

Evaluation artifacts must identify consent/license basis, fixture split, model/runtime
revisions, machine configuration, timestamps, scoring conventions, sample size and
confidence intervals. No live evaluation or recording took place for this documentation.
