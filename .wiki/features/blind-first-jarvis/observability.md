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

## Local counters

- announcements by priority/category/disposition;
- blocking announcement acknowledgement latency;
- `/status`, `/repeat`, and `/details` invocation counts;
- reducer and policy latency histograms;
- renderer fallback count;
- repeated-failure and invalidated-verification advisories;
- watcher events/failures once enabled.

Counters remain local and are exposed through diagnostics or trace evaluation. No new
telemetry SaaS or network export is introduced.

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
