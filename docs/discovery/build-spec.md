# Build Spec: Blind-first Jarvis upgrade

**Status:** draft, implementation-ready through Phase 3 under marked defaults
**Date:** 2026-07-29
**Decision source:** [decision ledger](decision-ledger.md)
**Technical design:** [design](../../.wiki/features/blind-first-jarvis/design.md)
**Implementation plan:** [tasks](../../.wiki/features/blind-first-jarvis/tasks.md)

_Regenerated 2026-07-29 from `decision-ledger.md` and repository/research artifacts. Do
not hand-edit during implementation; change the ledger/models, then regenerate._

## Purpose and completion signal

Athena must become a situationally aware technical partner whose state and decisions are
understandable without seeing the interface. A blind developer must be able to start a
session, express an outcome, follow progress, inspect details, answer permissions, recover
from errors, interrupt work, and review the result using a keyboard and assistive
technology without sighted interpretation.

The load-bearing invariant is:

> Every user-facing state claim is traceable to a user statement, a runtime event, or an
> explicitly labeled agent assertion; runtime evidence outranks agent assertion, and no
> consequential action bypasses Athena's existing permission and trust controls.

WCAG 2.2 supplies useful principles and test vocabulary, but this terminal product will
not claim WCAG conformance merely because web-oriented criteria were mapped. Conformance
claims require technology-appropriate evaluation and real assistive-technology testing.

Provenance: D-001, D-002, D-007, D-014.

## Glossary

- **Runtime fact:** state proven by Athena's engine, permission system, tool result, run
  budget, or lifecycle event. It is authoritative for operational truth. (D-007)
- **Agent assertion:** a model-authored objective, phase label, or next-step claim. It is
  useful context but never proof that an action succeeded. (D-007)
- **Semantic state:** the deterministic, presentation-independent snapshot of objective,
  phase, activity, attention, verified outcome, and next expected transition. (D-004)
- **Announcement:** a bounded, sourced expression of a semantic event with priority and a
  deduplication key. (D-004, D-006)
- **Screen-reader mode:** Athena's explicit append-only interactive presentation; it does
  not mean Athena detected a disability or replaced the user's AT. (D-005, D-006)
- **Assistive technology (AT):** a user's screen reader, Braille display, magnifier, voice
  control, or related system. Athena integrates through stable text/keyboard semantics.
- **Blocking attention:** unresolved state requiring a user decision, such as permission.
  It remains available until resolution.
- **Advisory:** guidance that may change a decision but has no authority over runtime,
  permission, trust, or sandbox policy. (D-010, D-011)
- **Watcher:** a later, explicitly created foreground monitor over an approved resource;
  it is not started by ordinary Athena boot. (D-009)

## Actors

- **Primary:** experienced blind developer using keyboard navigation, a screen reader,
  and optionally a refreshable Braille display.
- **Secondary:** sighted or low-vision developer who prefers a calm, queryable,
  non-visual interaction model.
- **System actor:** Athena's engine and deterministic interaction-state reducer.
- **Optional future actor:** a foreground watcher process observing explicitly approved
  resources between active turns.

Provenance: D-003, D-008, D-009.

## Roles and permissions matrix

| Action | User | Agent/model | Runtime/harness | Project configuration | Watcher |
|---|---|---|---|---|---|
| Select accessible presentation | Yes | No | Apply preference | No | No |
| State a goal | Yes | Assert only | Record source | No | No |
| Mark a tool/mutation/gate verified | No | No | Yes | No | No |
| Request a consequential action | Yes | Yes, through a tool | Gate it | No | Only within approved watch capability |
| Approve/deny permission | Yes | No | Enforce/record | No | No |
| Change global accessibility settings | Yes | No | Validate/write | No | No |
| Emit routine announcement | Configure policy | No direct control | Yes, from typed events | No | Yes, through same policy |
| Create a persistent watch | Yes | No | Validate scope | No | No |
| Override trust/sandbox/permissions | Only through existing explicit controls | No | Existing authority | No | No |

Every denied cell fails safe and emits a bounded recovery path where user action is
possible. Provenance: D-005, D-007, D-009, D-010, D-012.

## Walking skeleton

1. The user starts `athena --accessibility screen-reader`.
2. Athena prints one stable orientation line and a normal text prompt.
3. The user asks for an outcome such as "get this release ready."
4. Runtime events update a semantic snapshot and emit deduplicated announcements.
5. Routine tool activity stays quiet; phase changes, failures, permissions, and final
   outcomes are announced once with consistent language.
6. The user can ask `/status`, `/repeat`, `/details`, or press Escape at any time allowed
   by the current input boundary.
7. A permission request identifies the action, target, reason, risk, available keys, and
   a command for reviewing more detail without losing the decision context.
8. Completion reports verified results, unverified claims, untouched unrelated state,
   and the next human decision.
9. The same semantic events remain available to the existing TUI and JSONL output.

Provenance: D-001, D-004, D-006, D-007, D-013.

## Requirements and fit criteria

### R-001: Explicit accessible presentation

- **Given** Athena is started with `--accessibility screen-reader`, **when** the
  interactive session begins, **then** it uses neither animation, cursor-rewrite UI, nor
  the alternate-screen buffer and emits an append-only text stream.
- **Given** global settings select screen-reader mode, **when** a trusted or untrusted
  project supplies different presentation settings, **then** the global user preference
  remains authoritative.
- **Given** no accessibility preference is configured, **when** Athena starts, **then**
  existing TUI behavior is unchanged.
- **If** the accessible adapter cannot initialize, **then** Athena preserves the session,
  prints one plain fallback/recovery command, and does not silently enter fullscreen.

### R-002: Semantic interaction state

- **Given** any engine event sequence, **when** it is reduced, **then** Athena exposes a
  deterministic snapshot containing objective, runtime phase, current activity, pending
  attention, last verified outcome, and next expected transition where known.
- **Given** an agent-authored status conflicts with a tool result or run result, **when**
  the snapshot is queried, **then** the runtime fact wins and the conflict is traceable.
- **Given** no model provider is available, **when** existing runtime events are reduced,
  **then** state queries and announcements still work without a model call.
- **If** an event is malformed or from another run, **then** it cannot mutate the current
  snapshot and a bounded diagnostic references the rejected envelope.

### R-003: Announcement priority and noise control

- **Given** routine successful reads or progress ticks, **when** balanced verbosity is
  active, **then** they do not generate unsolicited announcements.
- **Given** a phase change, nonfatal failure, or background completion, **when** it occurs,
  **then** one concise `polite` announcement is emitted unless superseded by a higher
  priority event.
- **Given** a permission request, fatal error, blocked state, or user-required decision,
  **when** it occurs, **then** one `assertive` or `blocking` announcement is emitted and
  remains queryable until resolved.
- **Given** equivalent events arrive repeatedly, **when** the deduplication window is
  active, **then** they coalesce without hiding a changed count, target, severity, or
  required action.
- **If** announcement policy fails, **then** unresolved blocking attention remains in
  state and the presentation falls back to a plain critical message.

### R-004: Orientation and control

- **Given** a live or completed run, **when** the user invokes `/status`, **then** Athena
  answers from structured state in under 100 ms locally and uses no model call.
- **Given** an announcement was missed, **when** the user invokes `/repeat`, **then** the
  most recent material announcement is repeated exactly, without re-triggering its
  action.
- **Given** a concise summary, **when** the user invokes `/details`, **then** Athena emits
  bounded supporting detail and a route to the full trace or diff.
- **Given** an active turn, **when** the user presses Escape, **then** Athena announces
  whether cancellation was accepted and the resulting state.
- **If** no material announcement or detail exists, **then** the command states that
  plainly and offers `/status` rather than returning an empty response.

### R-005: Accessible permissions

- **Given** a mutating action requires approval, **when** it is presented, **then** the
  user hears or reads the tool, target, consequence summary, reason, available choices,
  and how to inspect the full diff before deciding.
- **Given** multiple permission requests arrive, **when** the user resolves one, **then**
  requests remain FIFO, uniquely identified, and never overwrite one another.
- **Given** no interactive adapter is available, **when** permission is required, **then**
  Athena continues to fail safe exactly as it does today.
- **Given** a permission request remains unanswered, **when** time passes, **then** it
  does not auto-approve or expire through a presentation-only timeout.
- **If** the presentation loses the request/resolution pairing, **then** the action is
  denied, queued mutations stop, and a recoverable diagnostic is recorded.

### R-006: Keyboard and non-visual parity

- **Given** any interactive Athena capability, **when** screen-reader mode is active,
  **then** it is reachable through documented keyboard input or an equivalent slash/CLI
  command without pointer input.
- **Given** color, bolding, borders, glyphs, or screen position communicate status in the
  standard TUI, **when** the same state is rendered in screen-reader mode, **then** its
  meaning is present in text.
- **Given** a terminal cannot distinguish a key sequence at Ink's input seam, **when** a
  workflow needs that action, **then** Athena uses an existing portable binding or slash
  command and does not re-propose a known platform-impossible binding.
- **If** a capability has no keyboard or command path, **then** the parity gate fails and
  that presentation cannot be called production-ready.

### R-007: Outcome-oriented behavior

- **Given** a broad user objective, **when** Athena starts acting, **then** the objective
  and current phase are represented in state without requiring the user to reconstruct
  them from tool logs.
- **Given** work reaches a natural phase boundary, **when** the boundary is verified,
  **then** Athena announces the transition and what will happen next.
- **Given** work finishes, **when** the run closes, **then** Athena distinguishes verified
  outcomes, unresolved risks, unrelated state left untouched, and any required human
  decision.
- **If** verification did not run or its result was invalidated by a later edit, **then**
  completion text labels it unverified and does not imply success.

### R-008: Proactive but governed attention

- **Given** deterministic evidence of repeated failure, invalidated verification, budget
  pressure, background completion, or a newly blocking condition, **when** the condition
  crosses its configured threshold, **then** Athena surfaces it once with a recommended
  response.
- **Given** an advisory from experience or memory, **when** it is presented, **then** it
  is labeled advisory and cannot deny tools or override permissions.
- **Given** no material change, **when** monitoring continues, **then** Athena remains
  silent.
- **If** a detector repeats without a changed condition, **then** it is coalesced and
  cannot loop or deny the underlying action.

### R-009: Persistent monitoring boundary

- **Given** the user has not explicitly created a watch, **when** Athena exits, **then**
  no new monitoring process persists.
- **Given** a user starts a foreground watch, **when** its approved resource changes,
  **then** it emits a semantic event through the same priority and redaction pipeline.
- **Given** a watcher backend is unavailable or fails, **when** Athena starts or resumes,
  **then** the failure is nonfatal and produces one actionable warning naming the
  watcher, backend, and recovery command.
- **If** a requested resource is outside approved scope, **then** watch creation is denied
  by existing resource policy and no process starts.

### R-010: Optional voice adapter

- **Given** no voice adapter is configured, **when** accessible mode operates, **then**
  every workflow remains complete through text, keyboard, screen reader, and Braille.
- **Given** direct speech is enabled, **when** a screen reader is also active by explicit
  user configuration, **then** Athena follows the user's selected ownership policy and
  does not double-speak routine output.
- **Given** speech recognition fails or is unavailable, **when** the user continues by
  keyboard, **then** no session state or control is lost.
- **If** speech ownership is ambiguous, **then** direct speech stays off and the user's
  screen reader remains the only speech source.

### R-011: Privacy, security, and evidence

- **Given** event payloads contain possible secrets, **when** announcements, traces, or
  diagnostic counters are written, **then** they pass through Athena's existing redaction
  behavior and raw values are not copied into telemetry.
- **Given** an accessibility or monitoring setting is project-controlled, **when** it
  attempts to weaken a global user preference or permission boundary, **then** it is
  ignored with a bounded warning.
- **Given** an announcement summarizes a prior event, **when** it is inspected, **then**
  it exposes a source event identifier or trace range sufficient for audit.
- **If** safe summarization cannot avoid a suspected secret, **then** the value is omitted
  and detail routes to the already redacted trace surface.

### R-012: Validation

- **Given** a pull request changes the semantic reducer or a presentation adapter,
  **when** CI runs, **then** deterministic keyboard, announcement, ordering, redaction,
  and transcript invariants are tested.
- **Given** a release candidate changes an interactive workflow, **when** it is promoted,
  **then** the affected core journeys have been manually tested with the supported screen
  reader and keyboard matrix.
- **Given** only row-count assertions pass for a fullscreen test, **when** layout is
  evaluated, **then** the test is insufficient; every captured frame must also pass the
  existing content-signature checks.
- **If** a release-changing journey lacks a completed manual AT row, **then** promotion is
  blocked for that support claim even when automated gates pass.

Requirements provenance: D-003 through D-014. Exact mappings and technical mechanisms are
recorded in the linked PRD, design, ADRs, and test strategy.

## Data and privacy map

The semantic snapshot is ephemeral and reconstructable. Existing traces remain the
evidence store. Additive global settings and later explicit watch definitions are the only
new persisted user data.

| Field/data | Purpose | Who sees it | Retention |
|---|---|---|---|
| Accessibility presentation/verbosity/speech ownership | Honor user interaction preferences | Local Athena runtime and user | Until user changes/removes global setting |
| Objective and agent assertion | Orient the current run | User, model context where already present, local trace | Existing session/trace policy |
| Runtime phase/activity/outcome | Provide trustworthy status | User and local adapters | Snapshot for run; source evidence follows trace policy |
| Attention and announcement metadata | Prioritize and debug notifications | User and local trace diagnostics | Bounded in memory; metadata follows trace policy |
| Permission request ID/summary/decision | Pair consequential decisions | User, permission engine, redacted trace | Existing trace/session policy |
| Watch ID/resource/scope/enabled state | Run a user-requested foreground monitor | Local user and harness | Until explicit removal; recoverable disable |
| Manual evaluation participant details | Understand AT-specific usability | Research team only, outside run traces | Minimum necessary study retention; no disability identity in Athena traces |

No new network telemetry, cross-machine sync, biometric/voiceprint storage, or raw speech
recording is authorized. Provenance: D-009 through D-014.

## Integrations and failure behavior

- **Engine/events:** input facts; malformed events are rejected without fabricating state.
- **Permissions/resource policy:** existing authority; unavailable interactive presentation
  defaults to denial.
- **Run traces:** canonical redacted evidence; trace failure follows existing primary-run
  preservation rules.
- **Experiential Layer:** advisory IDs and bounded context only; unavailable retrieval is
  silent/nonfatal unless explicitly queried.
- **Screen readers/terminals:** consume stable line output; incompatibility falls back to
  a plain recovery command and is scoped to the tested combination.
- **Future watcher/voice backends:** optional and probed; failure never aborts core boot.

## Quality targets

Numerical latency, boundedness, reliability, accessibility, security, cost, and resource
targets live in [NFR budgets](../../.wiki/features/blind-first-jarvis/nfr-budgets.md).
They are derived from the consequence that missed permissions/false completion can cause
unsafe actions (strict correctness) while routine state must feel immediate (100 ms local
status target) and add no model cost (D-007, D-010, D-013, D-014).

## Failure flows

- **Provider failure:** runtime state enters `failed`; the announcement remains available;
  `/status`, trace access, and retry guidance work locally.
- **Tool failure:** routine details remain bounded; repeated unchanged failures produce
  one reassessment advisory rather than repeated speech.
- **Renderer failure:** engine and trace continue; the adapter emits a bounded fallback
  error to stderr and preserves a recoverable session.
- **Screen-reader incompatibility:** user can switch to plain `athena exec --output
  jsonl` or classic line output; the issue is recorded against the terminal/AT matrix,
  not generalized as user error.
- **Optional watcher/migration failure:** warn and preserve the working interactive path;
  never become a fatal boot precondition.

## Explicit non-goals for the first production milestone

- Impersonating the film character, copying a voice, or adding decorative sci-fi UI.
- Replacing the user's screen reader.
- Claiming that voice equals accessibility.
- Always-on autonomous host control.
- Silent cross-project monitoring or cross-machine credential/memory sync.
- Inferring disability or screen-reader use without explicit user configuration.
- Replacing sessions, traces, permissions, memory, governed learning, or the planned
  Experiential Layer.
- Solving Ink's documented platform input limitations through unreachable keybindings.

Provenance: D-002, D-005, D-008 through D-013.

## Story playback

A blind developer starts Athena in screen-reader mode and asks her to prepare a release.
Athena quietly works from the objective, announces only meaningful phase changes, and
keeps `/status` available without a model call. A write requires approval, so Athena
states the file, summarized effect, reason, choices, and detail command. After approval,
tests reveal a regression; Athena announces it once and changes state to blocked. The
developer asks for details, directs the fix, and later receives a completion statement
that names verified gates, remaining risk, untouched unrelated files, and the fact that
nothing was pushed. At no point must the developer inspect a panel, spinner, color, or
screen position to understand the run.

## Assumption register and open questions

Assumed defaults are D-003 through D-009 and D-012 through D-015 in the
[decision ledger](decision-ledger.md). Artifact inferences are D-010 and D-011. The
  priority-ranked founder questions are Q-001 through Q-003. No implementation should
  begin until Nico confirms that this story playback and semantic-versus-voice sequence
  describe the intended product.

## Agent-facing mechanism appendix

- Keep TypeScript/Zod and Athena's current Node/Ink architecture; add no database or paid
  service. Revisit only if measured event volume or a separately approved backend demands
  it. (D-004, D-013)
- Add the semantic plane beside `EngineEvent`; do not replace the event contract in one
  migration. Revisit after every current consumer uses the versioned semantic seam. (D-004)
- Implement screen-reader interaction as line I/O rather than a second React renderer.
  Revisit only after the supported AT matrix proves another mechanism more reliable.
  (D-006)
- Keep non-voice watchers foreground-first. Reuse the tracked opt-in voice-daemon plan,
  but put its spoken digests and permissions over this semantic contract; resolve the
  current Realtime model during its probe instead of freezing the older draft's model.
  (D-008, D-009, D-016, D-017)
- Reuse redaction, traces, permissions, resource policy, sessions, hooks, and the
  Experiential Layer. A parallel implementation is a design failure. (D-010, D-011)
