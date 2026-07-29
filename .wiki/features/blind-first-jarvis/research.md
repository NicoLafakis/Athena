# Blind-first Jarvis upgrade - research basis

> [Objective overview](00-overview.md)

## Conclusions

1. **Accessibility is semantic before it is auditory.** Screen readers transform
   programmatically available text and state into speech or Braille. Voice synthesis is
   optional and can conflict with a user's existing assistive technology.
2. **Keyboard completeness is non-negotiable.** WCAG 2.2 requires keyboard-operable
   functionality and no keyboard trap. Although Athena is not a web page, these are useful
   product invariants for every interactive workflow.
3. **Dynamic status must be programmatically and predictably available.** WCAG's status
   message principle and live-region techniques distinguish ordinary updates from alerts
   that deserve interruption. Athena needs the equivalent in its own semantic event
   contract rather than relying on terminal position or color.
4. **Animation and alternate-screen rendering are presentation choices, not state.** Ink
   documents alternate-screen rendering as a separate buffer. Athena's current
   fullscreen mode also performs frequent animated and incremental redraws. A stable
   append-only adapter is the safer initial screen-reader contract.
5. **Automation cannot establish usability.** W3C recommends involving users with
   disabilities and warns against generalizing from one participant. Microsoft recommends
   accessibility checks as release gates plus manual keyboard and screen-reader tests.
6. **WCAG mapping is guidance, not a terminal conformance claim.** WCAG is written for
   web content and markup. The plan maps its durable principles while requiring
   technology-specific tests and real users.

## Current Athena findings

### Reusable foundations

- `EngineEvent` already types assistant text, tool lifecycle, todos, run limits, child
  status, compaction, errors, and status patches (`src/engine/types.ts`).
- `EngineEventBus` provides one live subscription seam (`src/engine/events.ts`).
- `RunTraceWriter` subscribes to the bus, redacts payloads, and writes a hash-chained
  evidence trail (`src/harness/traces.ts`).
- The engine has explicit permission, hook, abort, run-budget, and lifecycle seams
  (`src/engine/loop.ts`).
- Headless JSONL already exposes the engine stream (`src/cli.ts`).
- Sessions, child agents, and background shell tasks already preserve bounded state.
- Classic TUI mode has normal scrollback; fullscreen mode explicitly uses an alternate
  screen and a fixed-height Ink layout.

### Missing contracts

- Events are renderer-oriented, not an explicit user-attention or semantic-state model.
- Permission requests are bridged into React state and are not first-class semantic
  events with a common adapter contract.
- Busy state is represented visually by a 120 ms animated spinner.
- The transcript reducer prints most child and tool transitions without an interruption
  or deduplication policy.
- No screen-reader presentation, accessibility preference, `/status`, `/repeat`, or
  announcement history exists.
- No supported assistive-technology matrix or manual accessibility release gate exists.
- Background tasks live only within the current process; there is no consented persistent
  watcher lifecycle.

### Overlap with planned systems

An earlier experiential draft proposed deterministic trace compilation, bounded
retrieval, active-versus-provisional guidance, midstream repeated-failure advice, and
internal hooks. Its useful decisions are now reconciled into the canonical
[Experiential Layer component](experience.md); the standalone draft was removed.

The existing self-reflection-journal and memory-hygiene wiki plans remain separate:

- The journal records evidence-grounded predictions and outcomes.
- Memory hygiene verifies and governs free-text facts.
- The Experiential Layer retrieves past situations and advisory guidance.
- The interaction layer decides what Athena is doing now and what the user must know.

They may share event identifiers and trace references, but not stores or authority.

An earlier voice draft in commit `3bc1ce6` established an opt-in voice daemon, local wake
word, OpenAI Realtime conductor, engine-session router, voice permissions, and a later
control channel. Its useful decisions are now reconciled into the canonical
[voice component](voice.md); the standalone roadmap was removed. The first working
composition proved a local wake gate, raw microphone audio into Realtime, Marin playback,
and a separately confirmed resumable `athena exec` child. It remains an intermediate
proxy composition, not the final product boundary.

The [direct-harness voice specification](direct-harness-voice.md) and
[ADR 0003](adr/0003-realtime-as-audio-adapter.md) supersede preservation of that conductor
boundary. Realtime is to interpret post-wake audio and speak results while the semantic
state, announcement plane, permissions, reasoning, tools, and claims about work remain
owned by one Athena harness session.

Official OpenAI documentation checked 2026-07-29 resolved `gpt-realtime-2.1` as the
quality model and `gpt-realtime-2.1-mini` as the implemented lower-cost default. Current
availability, API contracts, retention, and prices must still be rechecked before making
support, privacy, or cost claims.

## Primary sources

- [WCAG 2.2](https://www.w3.org/TR/WCAG22/) - keyboard operation, no keyboard trap,
  non-color semantics, name/role/value, and status-message principles.
- [W3C ARIA19 live-region technique](https://www.w3.org/WAI/WCAG22/Techniques/aria/ARIA19)
  - errors and assertive updates can be announced without moving focus; used here as a
  priority-model analogy, not as terminal markup.
- [W3C: Involving Users in Evaluating Web Accessibility](https://www.w3.org/WAI/test-evaluate/involving-users/)
  - include users with disabilities, match participant expertise to the product, and do
  not generalize from one participant.
- [Microsoft accessibility overview](https://learn.microsoft.com/en-us/windows/apps/design/accessibility/accessibility-overview)
  - screen readers consume programmatic information and produce speech or Braille; good
  keyboard and screen-reader support benefits multiple assistive technologies.
- [Microsoft accessibility testing](https://learn.microsoft.com/en-us/windows/apps/design/accessibility/accessibility-testing)
  - accessibility as a release gate, logical keyboard navigation, and manual Narrator
  validation where human judgment is required.
- [Ink releases](https://github.com/vadimdemedes/ink/releases) - confirms alternate-screen
  rendering is a distinct buffer and documents input distinctions that vary by terminal.
- [OpenAI GPT-Realtime-2.1 model page](https://developers.openai.com/api/docs/models/gpt-realtime-2.1)
  - current official evidence for audio input/output, tool use/function calling, model
  identifier, and API availability at the time of this research.
- [OpenAI GPT-Realtime-2.1 mini model page](https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini)
  - current official lower-cost voice-agent alternative; selection remains a voice-spike
  decision, not a blind-first semantic-layer dependency.

## Research still required during implementation

- Moderated workflow studies with several experienced blind developers rather than one
  proxy persona.
- NVDA and Narrator behavior in Windows Terminal for append-only output, input echo,
  progress lines, Ctrl+C/Escape, and permission prompts.
- VoiceOver behavior in macOS Terminal and at least one common alternative terminal.
- Orca behavior in a supported Linux terminal and over SSH.
- Refreshable Braille review of verbosity, punctuation, code paths, and diff summaries.
- Whether direct speech offers value beyond the user's screen reader without creating
  duplicate output or focus conflicts.

## Proxy baseline artifacts (2026-07-29)

`tests/fixtures/interaction/core-journeys.json` records the canonical baseline journeys
as stable user/runtime/Athena sequences. It was derived from the build specification and
redacted run shapes, not from a blind participant, and therefore carries an explicit
`proxy-baseline` status. `src/interaction/vocabulary.ts` similarly freezes seven candidate
terms for distinction testing without putting them into production presentation.

`tests/fixtures/interaction/attention-quality.json` records redacted detector event
patterns, including the same repeated-failure sequence exercised by the real CLI
hash-chained trace regression. Helpful and quiet cases are replayed through the production
adapter. These artifacts reduce engineering ambiguity but do not satisfy recruitment,
manual screen-reader testing, or blind-user release validation.
