# Blind-first Jarvis upgrade - non-functional budgets

> [Objective overview](00-overview.md) | [Test strategy](test-strategy.md)

## Accessibility and usability

- 100% of core interactive capabilities have keyboard or slash/CLI equivalents.
- Zero essential meanings depend only on color, animation, glyph, border, or position.
- Zero lost, duplicated, or auto-dismissed blocking announcements in deterministic tests.
- Screen-reader mode emits no cursor-rewrite or alternate-screen escape sequences.
- Core release journeys complete without sighted interpretation in the supported manual
  matrix.
- `/status` clearly distinguishes runtime-verified facts from agent assertions.

## Latency

- State reduction: p95 below 5 ms per event on the development machine.
- Announcement classification: p95 below 5 ms per event.
- `/status`, `/repeat`, and local `/details`: p95 below 100 ms, zero model calls.
- Presentation must not add more than 25 ms p95 to tool-result processing.
- Timed progress announcements default to at most once per 60 seconds and remain off or
  milestone-only unless explicitly selected.

Timing CI uses loose regression bounds across platforms; deterministic functional
failures remain hard gates.

## Noise and boundedness

- Balanced mode emits no unsolicited announcement for routine successful read-only tools.
- Equivalent repeated events coalesce; blocking events never coalesce across distinct
  targets or decisions.
- Recent announcement history is bounded by count and characters; full history remains in
  traces.
- Every announcement and detail field has explicit character limits.
- Assistant streamed text is not duplicated as announcements.

Dogfood determines a useful helpful-to-unhelpful ratio before defaults change. The plan
does not invent a numerical ratio before blind users have evaluated real sessions.

## Reliability

- Reducer results are deterministic for a given ordered event stream and reducer version.
- Optional accessibility, watcher, experience, and speech hardening never becomes a fatal
  boot precondition.
- Renderer failure preserves the trace and primary run result.
- Permission queues are lossless FIFO and default-deny without an interactive adapter.
- Parent, child, and watcher state is isolated by run/watch ID.

## Security and privacy

- Zero known secret-shaped values in announcement, semantic JSONL, or watcher fixtures.
- Project settings cannot weaken global accessibility or speech ownership preferences.
- No new network call, paid service, or background model call in Phases 1-5.
- Watchers observe only explicitly approved resources and have a visible recovery/stop
  command.

## Cost and resources

- State and announcement plane: zero incremental model calls and zero LLM tokens.
- In-memory snapshot plus recent history: target under 5 MB per active run at hard limits.
- Foreground watcher idle target: below 1% CPU averaged over five minutes; memory budget is
  set after a prototype because backend choice materially affects it.
- Direct voice has no approved cost or dependency budget until its gated research phase.
