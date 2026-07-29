# PRD: Blind-first Jarvis interaction layer

- **Status:** Proposed
- **Priority:** P0 foundation, P1 proactivity, P2 voice
- **Owner surface:** `src/engine/`, `src/harness/`, `src/tui/`, `src/cli.ts`, new
  `src/interaction/` and `src/presentation/`
- **Migration:** additive global settings only; no destructive data migration
- **Related:** [overview](00-overview.md),
  [build specification](../../../docs/discovery/build-spec.md),
  [design](design.md), [tasks](tasks.md)

## 1. Overview, problem, and goal

Athena exposes powerful agent behavior through a largely visual, turn-oriented terminal
interface. Users must currently infer live state from transcript entries, spinners,
panels, colors, and screen position. The goal is to make Athena's operational meaning
explicit, queryable, calm, and usable without sight, then reuse that foundation for
Jarvis-like awareness and proactivity.

## 2. Load-bearing invariant

Every user-facing state claim is traceable to a user statement, runtime event, or
explicitly labeled agent assertion. Runtime evidence outranks agent assertion, and no
consequential action bypasses existing permission, trust, sandbox, or trace controls.

## 3. Goals

1. Complete all core interactive journeys with keyboard plus screen reader or Braille.
2. Produce stable semantic state and meaningful announcements without extra model calls.
3. Give users instant answers to "what are you doing, why, and what needs me?"
4. Reduce unsolicited activity output while guaranteeing delivery of blocking events.
5. Make the same state contract reusable by TUI, text, JSONL, watchers, and future voice.
6. Add proactivity only where evidence, consent, and recovery are explicit.

## 4. Non-goals

- Film-character imitation, decorative visual redesign, or cloned voice.
- Replacing a screen reader or making voice mandatory.
- An always-on daemon in the first production milestone.
- A new experience, memory, journal, permissions, or trace store.
- Automatic approval, cross-machine credential sync, or disability inference.

## 5. Personas and user stories

- As an experienced blind developer, I want Athena's state and choices in a stable text
  stream so that I can work independently with speech or Braille.
- As a developer, I want routine activity quiet and material changes announced so that I
  can focus on outcomes rather than logs.
- As a cautious operator, I want claims tied to runtime evidence so that conversational
  confidence never hides incomplete or failed work.
- As an automation client, I want versioned semantic events so that I can consume the same
  state without scraping terminal presentation.

## 6. Functional requirements

FR-001 through FR-012 are defined with failure pairs and fit criteria in the
[canonical build specification](../../../docs/discovery/build-spec.md). They cover:

- explicit screen-reader presentation;
- semantic state and evidence precedence;
- announcement priority, coalescing, and verbosity;
- status/repeat/detail/cancel controls;
- accessible permission decisions;
- keyboard and non-visual parity;
- outcome-oriented progress;
- governed proactive attention;
- optional foreground monitoring;
- optional voice;
- privacy, security, evidence, and validation.

## 7. Data model and schema

No database is introduced. New versioned TypeScript/Zod contracts:

- `InteractionEventEnvelope`: per-run sequence, timestamp, source, source event reference,
  category, and bounded payload.
- `InteractionSnapshot`: objective, runtime phase, activity, attention queue, last
  verified outcome, next expected transition, and provenance.
- `Announcement`: priority, text, dedupe key, source reference, created time, and whether
  user acknowledgement is required.
- `AccessibilitySettings`: presentation, verbosity, progress cadence, punctuation/detail
  preference, and explicitly configured speech ownership.
- `WatchDefinition` in a later phase: resource, trigger, scope, permission provenance,
  enabled state, and recovery command.

State is in memory and reconstructable from events. Traces remain canonical evidence.
Only settings and later explicit watch definitions persist.

## 8. Surfaces and UX

- New CLI option: `--accessibility screen-reader|standard`.
- New global settings object: `accessibility` with safe additive defaults.
- New slash commands: `/status`, `/repeat`, `/details`, and `/verbosity`.
- A screen-reader interactive adapter using stable line-oriented input/output.
- Existing TUI remains visually unchanged until Nico separately approves specific
  frontend modifications under the active Global Rule.
- Existing JSONL gains additive versioned semantic events.

Empty, loading, blocked, error, canceled, and complete states each have explicit text.

## 9. Interface contract

The semantic event and snapshot contracts are internal public seams for renderers and
JSONL. They are additive; existing `EngineEvent` consumers remain supported during
migration. Programmatic clients receive schema-versioned event envelopes. Interactive
actions have CLI/slash parity where terminal key sequences are unavailable.

## 10. Security, authorization, and access control

- Existing `PermissionEngine`, `ResourcePolicy`, hook gates, trust digests, and sandbox
  policy remain authoritative.
- Screen-reader and voice output use redacted, bounded summaries.
- Project settings cannot disable or weaken global accessibility preferences.
- Watchers require explicit resource scope and use the existing trust/resource policy.
- Untrusted tool/model content cannot set announcement priority to suppress or fabricate
  a runtime blocking event.

## 11. Data integrity and write path

- State transitions are pure reducer operations over ordered envelopes.
- Per-run sequence numbers and source references prevent ambiguous ordering.
- Permission request/resolution pairs carry stable IDs and remain FIFO.
- Trace append remains the evidence write path; the interaction layer does not create a
  competing audit log.
- Finalization must be idempotent and central, aligning with the Experiential Layer plan.

## 12. Testing strategy

See [test strategy](test-strategy.md). Unit tests cover pure reducers and announcement
policy; integration tests cover engine, permissions, traces, JSONL, and input; manual
tests cover real terminals, screen readers, and Braille. Fullscreen changes retain the
existing every-frame content-signature invariant.

## 13. Observability and logging

See [observability](observability.md). Record semantic metadata and source references,
never duplicate raw prompt/tool content. Operators can reconstruct "what happened and
why" from the trace plus reducer version.

## 14. Error handling and user feedback

- Presentation failure does not erase the session or engine result.
- State failure emits a bounded diagnostic and falls back to raw/classic output.
- Optional watcher, voice, or migration failure is nonfatal and names the artifact,
  backend, and recovery command.
- Blocking prompts never time out into approval.
- Every failure remains queryable through `/status` or the trace.

## 15. Performance and cost

See [NFR budgets](nfr-budgets.md). Routine state and announcement work uses zero model
calls, bounded text, constant-size recent-announcement history, and low-millisecond local
processing. No new paid service is approved by this PRD.

## 16. Accessibility

WCAG 2.2 AA principles guide keyboard operation, no traps, non-color meaning, predictable
order, status messages, and labels. Terminal-specific conformance is established through
the support matrix and real-user validation, not a web conformance claim. Speech and
Braille are both first-class outputs of the user's assistive technology.

## 17. Phases and rollout

1. Co-design fixtures and semantic contracts.
2. Runtime state reducer and evidence precedence.
3. Announcement policy and append-only screen-reader adapter.
4. Permission, status, repeat, detail, and interruption parity.
5. In-session proactive triggers and Experiential Layer integration.
6. Opt-in foreground watchers.
7. Integrate the tracked opt-in voice-daemon plan over the semantic contract after its
   capability probe and current-model check.

See [rollout](rollout.md) for gates and rollback.

## 18. Reuse, do not fork

Must reuse:

- `EngineEventBus` and `EngineEvent` migration seam;
- `RunTraceWriter` redaction and evidence;
- `PermissionEngine`, `PermissionBridge` semantics, and resource policy;
- `HookRunner` lifecycle events;
- sessions, child run IDs, `RunBudget`, and abort path;
- JSONL output contract;
- `popupLayout`/`popupLine` and fullscreen row budgeting for any later visual work;
- the planned Experiential Layer for experience retrieval;
- self-reflection and memory-hygiene boundaries documented in `.wiki/architecture/`.

## 19. Acceptance criteria

The release checklist is the full set of R-001 through R-012 fit criteria plus the
[NFR budgets](nfr-budgets.md). A release is rejected if it violates the load-bearing
invariant even when all cosmetic behavior appears correct.

## 20. Dependencies and integration points

- Existing Node, Ink, React, Zod, traces, settings, hooks, permissions, sessions, agents,
  tools, and CLI.
- Real NVDA/Narrator testing for Windows release support.
- Later platform cohorts require VoiceOver/macOS and Orca/Linux access.
- The Experiential Layer is a Phase 5 integration dependency, not a blocker for Phases
  1-4.
- Any direct speech or OS notification dependency requires separate approval.

## 21. Open questions

See Q-001 through Q-003 in the
[decision ledger](../../../docs/discovery/decision-ledger.md). No engineering mechanism
question is delegated to the founder.

## 22. Companion ADRs

- [ADR 0001: semantic event plane](adr/0001-semantic-event-plane.md)
- [ADR 0002: append-only screen-reader adapter](adr/0002-append-only-screen-reader-adapter.md)

## Implementation estimate

Approximately 180k-260k implementation and verification tokens across the first five
phases, split into independently shippable commits. The tracked voice-daemon plan has its
own estimate boundary; this package adds the semantic digest, truth, accessibility, and
permission prerequisites it must consume.
