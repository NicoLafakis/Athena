# Blind-first Jarvis upgrade - Experiential Layer component

> [Objective overview](00-overview.md) | [Technical design](design.md) |
> [Implementation tasks](tasks.md)

Cross-project conversation recall and long-horizon personal memory are specified in the
separate [Conversational Continuity package](../conversational-continuity/00-overview.md).
Experience remains bounded, project-scoped task-outcome guidance and does not replace
conversation episodes or durable user memory.

## Role and authority

The Experiential Layer helps Athena recognize relevant prior situations and offer
evidence-backed advice. It is a component of this upgrade, not a second memory system or
an authority over current runtime state.

It may answer, “What happened in similar work, and what should I consider?” It cannot
answer, “What is happening now?” without the interaction snapshot, and it cannot approve,
deny, or execute a tool. Runtime evidence, permissions, resource policy, and governed
learning remain authoritative.

## Constraints

- Compile only from redacted run traces and existing evidence references.
- Use deterministic local processing; no background model call is required for capture,
  retrieval, filtering, or routine guidance.
- Add no native database in v1. Use bounded JSON/JSONL indexes and existing local search
  primitives; replace storage only after measured need.
- Store provenance, schema version, timestamps, project scope, confidence, and lifecycle
  state with every record.
- Treat new guidance as `provisional`. Only explicit review or existing governed-learning
  promotion makes it `active`.
- Retrieval is advisory, bounded by count and characters, and returns no-hit normally.
- Never copy secrets, raw credentials, unbounded tool output, or raw speech into records.

## Contracts

```ts
interface ExperienceRecord {
  schemaVersion: 1
  id: string
  projectScope: string
  situation: string
  actions: string[]
  outcome: 'succeeded' | 'failed' | 'mixed' | 'aborted' | 'limited'
  evidenceRefs: string[]
  tags: string[]
  createdAt: string
}

interface GuidanceRecord {
  schemaVersion: 1
  id: string
  experienceIds: string[]
  signal: 'consider' | 'avoid' | 'stop-if' | 'switch-if'
  text: string
  status: 'provisional' | 'active' | 'retired'
  confidence: number
  reviewedAt?: string
}
```

Persisted and external forms are Zod-validated and length-capped. IDs and evidence
references, not retrieved prose, cross into `InteractionEventEnvelope` metadata.

## Deterministic pipeline

```text
redacted completed trace
  -> validate and normalize
  -> compile ExperienceRecord
  -> derive provisional guidance candidates
  -> atomic append/index update

current objective + bounded runtime facts
  -> project/tag/text candidate retrieval
  -> lifecycle and confidence filters
  -> stable ranking and character budget
  -> advisory IDs + bounded guidance
  -> AnnouncementPolicy decides whether to speak or remain quiet
```

Ranking inputs and tie-breakers must be explicit and testable. A retrieval miss, corrupt
optional index, or compiler failure warns on direct query and otherwise degrades to no
advice; it never blocks Athena's boot or primary run.

## Midstream signals

The first live integration is repeated failure: the same normalized tool action fails
twice without a meaningful input or environment change. The detector queries active
`avoid`, `stop-if`, and `switch-if` guidance once for that condition sequence. Any result
is labeled `Advisory:` and coalesced. A changed target, input, or verified environment
fact starts a new sequence.

Other detectors may request experience only through bounded hooks. They cannot loop on
their own output, mutate the snapshot, deny an action, or promote guidance.

## User controls and tests

Expose inspectable commands to search, show provenance, review provisional guidance,
retire guidance, rebuild an index, and report status. Destructive removal follows the
existing recoverability policy; index rebuilds are safe because traces remain canonical.

Tests cover deterministic compilation, schema rejection, stable ranking, project scope,
privacy/redaction, active/provisional filtering, bounded context, no-hit behavior,
repeated-failure reset/coalescing, corrupt-index recovery, and proof that advisories do
not affect permission decisions.

## Implementation status (2026-07-29)

The canonical implementation now lives in `src/experience/`; there is no parallel
experience implementation under `src/interaction/`, `src/learning/`, or the voice plan.
Completed verified run traces are hash-chain verified, redacted, and deterministically
compiled after shutdown into bounded atomic JSONL records. Each run also derives one
provisional guidance candidate. Capture is best-effort: invalid traces, unreadable
indexes, and capacity limits leave the completed run unchanged.

Retrieval is deterministic and project-scoped. It filters to reviewed `active` records,
applies confidence and freshness thresholds, ranks by explicit tag/text overlap with
stable tie-breaking, and enforces count and character budgets. Repeated unchanged tool
failure is the first live consumer. Only guidance ID, experience IDs, signal, and
confidence cross the semantic event seam; retrieved prose stays in the experience
store. The reducer treats this event as metadata and cannot let it mutate objectives,
phases, verified outcomes, or permission decisions.

User-facing search, provenance, review, retirement, and rebuild commands remain a
presentation task. Their visible command/menu surfaces are intentionally not changed
until Nico approves those specific frontend elements; the validated store operations
and safe rebuild recovery contract are the backend seam they will call.
