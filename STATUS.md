# Voice capability ("blind-first Jarvis")

Last updated: 2026-10-10
Spec of record: [`.wiki/features/blind-first-jarvis/direct-harness-voice.md`](.wiki/features/blind-first-jarvis/direct-harness-voice.md)

## Current state

The voice flow uses the shared `HarnessSessionController`, canonical permission decisions through `VoiceAttentionBridge`, a persistent Windows wake listener, reconnectable Realtime sessions, and local lifecycle telemetry. Voice and keyboard answers share the same validated permission path. The wake listener now drops recognized phrases while Athena audio is playing, preventing output from feeding back as a new command.

The GPT-6/6.1 model registry and reasoning selections were verified against official
OpenAI docs and the account catalog on 2026-10-10. OpenAI defaults to GPT-6.1 Sol
medium; all four available family models are selectable, with 22 legal effort
pairs. `none` is offered only for GPT-6 Sol/Luna. One isolated live GPT-6.1 Sol
medium consolidation passed with explicit wire effort/model, persistence and
unchanged repeat. Other pairs have local request-contract coverage. See the
[capability matrix and proof limits](.wiki/architecture/model-selection.md).

## Remaining work

- Complete the live acceptance run with screen reader off, NVDA, and Narrator, using the procedure in the spec's [acceptance runbook](.wiki/features/blind-first-jarvis/acceptance-runbook.md).
- Reconcile any new findings from that hardware run with the spec and implementation.

The automated voice work and playback echo guard are implemented. Live
accessibility acceptance remains open as described above.

## Bounded source investigation (2026-10-10)

The implementation includes a bundled investigation skill, strict structured
result contract, versioned evidence/claim ledger, and engine completion checks.
It uses the existing source Read tool, shared controller, traces, and durable
children. Repeated evidence keeps its identity; changed source revisions stale
claims; contradictory, missing, unsupported, and unresolved evidence cannot pass.

The implemented provider checks literal source-text predicates. Behavior,
runtime, external effects, binary analysis, automatic unknown resolution, and
cross-worktree reloads remain deferred. See
[the implemented contract and limits](.wiki/architecture/source-investigation.md).

## Optional journal lifecycle (2026-10-10, implemented)

The shared controller now owns optional trace capture, a bounded daily pass,
subjective evidence-linked notes, durable provisional memory and relationships,
and revalidated ephemeral project retrieval. Human enablement defaults to
09:00 America/New_York; capture needs no model and synthesis allows at most two
one-shot attempts per day. Persistence, reload, repetition, contradictions,
rejection, source staleness/missingness, cancellation and malformed/provider-free
cases have lifecycle coverage. See [controls and limits](.wiki/architecture/self-reflection-journal.md).

The journal is implemented and disabled by default. A separately approved
machine-local Windows task supports closed-UI runs through the same runtime;
three actual demand starts verified a metadata-only checkpoint and unchanged
repeats with zero model calls. At the 19:00 UTC hourly check, LastRunTime advanced
to 19:00:01 and ready/result 0 was observed by 19:00:23, reusing the completed
checkpoint without additional attempts or memories;
natural attribution uses scheduled/last-run times because history is disabled. A bundled
cross-platform scheduler, the full conversation timeline, legacy free-text hygiene
and active-claim promotion remain deferred. Model interpretations stay inferred
even when source integrity checks pass; the journal cannot satisfy investigation
behavior-proof requirements.
