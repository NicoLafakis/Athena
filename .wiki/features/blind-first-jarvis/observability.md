# Blind-first Jarvis upgrade - observability

> [Objective overview](00-overview.md) | [NFR budgets](nfr-budgets.md)

## Objective

Answer these questions after a run without storing a second transcript:

- What did Athena believe the current state was?
- Which runtime or user event justified that state?
- What did Athena announce, suppress, or coalesce, and why?
- Was the user waiting on Athena, or Athena waiting on the user?
- Did a presentation, watcher, or optional backend fail?

## Trace events

Add metadata-only events to the existing hash-chained run trace:

```ts
type InteractionTraceEvent =
  | {
      type: 'interaction-event'
      reducerVersion: 1
      interactionSchemaVersion: 1
      interactionEventId: string
      interactionRunId: string
      sourceSequence: number
      source: InteractionSource
      kind: InteractionEventKind
      sourceRef?: string
      payloadDigest: string
    }
  | {
      type: 'interaction-announcement'
      announcementId: string
      priority: AnnouncementPriority
      disposition: 'emitted' | 'coalesced'
      category: string
      dedupeKeyHash: string
      sourceSequences: number[]
      chars: number
      occurrences: number
    }
  | {
      type: 'presentation-error'
      presentation: string
      operation: string
      recovery: string
    }
```

The implemented records do not duplicate semantic payloads, announcement text, prompts,
tool inputs, diffs, or secret values. Payload and dedupe hashes permit correlation
without disclosure; existing trace events already hold redacted evidence. Source sequence
references join the two. Suppressed routine events create no announcement record; their
accepted interaction metadata still records the policy input.

The run trace intentionally stores metadata and payload digests. In contrast, explicit
`athena exec --output jsonl` is a user-selected presentation/automation stream and emits
the full validated, bounded, redacted semantic envelope. It does not change trace
retention or create a second persisted transcript.

## Local counters

- announcements by priority/category/disposition;
- blocking announcement acknowledgement latency;
- `/status`, `/repeat`, and `/details` invocation counts;
- reducer and policy latency histograms;
- renderer fallback count;
- repeated-failure and invalidated-verification advisories;
- 75%/90% budget crossings and child/background aggregate transitions;
- watcher events/failures once enabled.

The watcher foundation exposes only backend name, availability, probe time, watch ID,
lifecycle, and the generic `changed` observation. Resource paths remain in the local
definition store and do not cross observation/announcement metadata; backend error text
is replaced with a bounded recovery route.

Counters remain local and are exposed through diagnostics or trace evaluation. No new
telemetry SaaS or network export is introduced.

## Voice lifecycle ledger (schemaVersion 2)

`~/.athena/voice-usage.jsonl` was `{schemaVersion, timestamp, model, usage}` and could not
evaluate either NFR budget: no turn identity, no latency, no correlation to a harness run.
Since 2026-08-13 it carries bounded lifecycle records. The old usage line survives as
`event: 'provider.usage'` with its counters under `meters`.

```text
{ schemaVersion: 2, timestamp, model,
  event, label?, source?: 'audio'|'keyboard',
  voiceTurnId?, permissionId?, harnessSessionId?, runId?,
  ms?, meters? }            // .strict()
```

**There is deliberately no free-text field on this record.** Every value is a literal, a
closed enum, a bounded integer, a generator-shaped ID, or a numbers-only meters tree, and
`.strict()` fails a record carrying an unexpected key rather than letting it ride along.
ID patterns are pinned to their real generators, so a transcript, an absolute path, or an
API key satisfies none of them. This is what makes "no transcript reached the ledger" a
checkable property rather than a caller-discipline promise; `tests/voice/integration.test.ts`
asserts it by driving a fake key, a real Windows path, and a distinctive phrase through the
whole session and proving they land nowhere here while the phrase does reach the run trace.

Events: `session.ready`, `wake.accepted|rejected|restart|failed`,
`realtime.connect|renewal|lost`, `turn.submitted|refused|feedback|completed|failed`,
`permission.wait|resolved|refused`, `playback.spoken|failed`, `provider.usage`,
`ledger.dropped`. Labels are a single closed vocabulary (`wake-phrase`, `low-confidence`,
`ambient`, `duplicate`, `busy`, `stale`, `same-turn`, `write-failed`, and so on) so a
counter is a number and a bounded enum label, never a place a summary can arrive. A
rejected wake records its label and nothing about what was said.

The two budgets are measured as:

- `session.ready.ms` — from `performance.timeOrigin`, so it honestly covers process launch,
  key resolution, and controller creation rather than starting the clock late.
- `turn.feedback.ms` — from the utterance arriving to the first thing Athena actually
  SAYS. Deliberately not to the status line: a status line is not feedback to a blind user.

Harness work is measured separately as `turn.completed`/`turn.failed`, correlated by
`voiceTurnId` + `harnessSessionId` + `runId`, so slow work never masquerades as slow
feedback.

Telemetry can never take voice down. A write failure warns once naming the file and the
recovery command, again at a three-failure budget, then keeps counting in memory with
persistence off. Bounding is always visible as `ledger.dropped` rather than looking like
full coverage.

One residual: `voiceTurnId` embeds a truncated hash of the normalized utterance, so it is a
weak confirmation oracle for a guessed phrase. It is accepted because `submitTurn` already
records the full prompt to the run trace on the same machine, so the hash reveals strictly
less than what sits beside it.

Detector state is deliberately non-transcriptive: repeated failures retain normalized
input digests rather than arguments, verification retains gate/call labels, budget
thresholds retain emitted flags, and work aggregation retains bounded active IDs. Exact
usage remains in the redacted source `budget-status` event; unsolicited advisory text
contains only its crossed percentage.

## Accessibility dogfood record

Manual sessions record a separate test sheet containing terminal, OS, screen reader,
screen-reader settings, Athena presentation/verbosity, journey results, missed/duplicate
announcements, disorientation points, and participant-reported workload. Never place
participant identity or disability details in a run trace.

## Diagnostics

Extend `athena doctor` only after a real capability probe exists. It may report:

- screen-reader presentation configuration valid/invalid;
- stdout interactive and append-only adapter available;
- optional speech or watcher backend probe result;
- last bounded backend error and recovery command.

It must not claim that a screen reader is running or that accessibility is "healthy" from
an executable, OS string, or hard-coded literal.

## Alerts

In-session:

- reducer invariant violation: fatal for the semantic adapter, fall back to raw/classic
  output, preserve the primary engine run;
- dropped blocking announcement or permission mismatch: fail the affected action safe;
- optional presentation/watch backend failure: one assertive warning, then bounded quiet
  fallback.

Persistent external alerting is out of scope until an explicit watcher product boundary
is approved.
