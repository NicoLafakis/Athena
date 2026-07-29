# Blind-first Jarvis upgrade - rollout and runbook

> [Objective overview](00-overview.md) | [Tasks](tasks.md) |
> [Test strategy](test-strategy.md)

## Flags and settings

- Existing behavior remains default through initial dogfood.
- `--accessibility screen-reader` enables the line adapter for one invocation.
- Global `accessibility.presentation: screen-reader` opts the user in persistently.
- Project settings cannot override global accessibility preferences.
- In-session proactive detectors have individual flags until their noise gates pass.
- Foreground watchers and direct speech are separately opt-in and absent until their
  phases are approved.

## Phases and exit gates

### Phase 0: co-design and fixtures

- Interview and observe several experienced blind developers on comparable coding-agent
  workflows.
- Establish exact core journeys, vocabulary, verbosity controls, and AT matrix.
- Build event fixtures before production modules.

**Exit:** decision ledger updated; no blocking product ambiguity for Phases 1-3.

### Phase 1: semantic truth plane

- Versioned event envelopes, reducer, provenance, runtime-over-agent precedence, replay
  tests, and trace metadata.

**Exit:** reducer fixtures and invariant/property tests pass; existing behavior unchanged.

### Phase 2: announcement policy

- Priority, coalescing, blocking retention, redaction, bounded history, and local status
  formatters.

**Exit:** every blocking/error/complete fixture emits exactly once; routine read fixtures
remain silent in balanced mode; zero secret leaks.

### Phase 3: screen-reader interactive mode

- Append-only presentation, global setting/CLI flag, commands, accessible permissions,
  cancellation feedback, and JSONL semantic events.

**Exit:** Windows NVDA and Narrator matrix passes core journeys; blind-user sessions have
no sighted-intervention blocker; all repository gates pass.

### Phase 4: outcome-oriented status and proactivity

- Bounded agent status assertions, phase milestones, repeated-failure, invalidated-gate,
  budget, child, and background attention detectors.

**Exit:** helpful/unhelpful review favors each enabled detector; no advisory loops; state
always labels assertion versus verification.

### Phase 5: experience integration

- Consume qualifying advisory events from the existing Experiential Layer plan.

**Exit:** its no-hit, context, provenance, and approval gates pass; interaction tests prove
experience cannot override permissions or runtime truth.

### Phase 6: foreground watchers

- Explicit `athena watch`, capability probes, scoped resources, local notifications, and
  stop/recovery commands.

**Exit:** optional backend failure is nonfatal across Windows/macOS/Linux; idle resource
budget and privacy review pass; Nico confirms demand for an always-on follow-up.

### Phase 7: tracked opt-in voice mode

- Bring in the existing `athena voice` daemon/session-routing plan, replace its ad hoc
  status digest with semantic snapshots/announcements, re-resolve the current supported
  Realtime model from official OpenAI docs, and retain speech ownership plus complete
  keyboard/Braille fallback.

**Exit:** voice improves tested workflows and does not double-speak, block Braille, or
  become required for any capability.

## Rollback

### Phases 1-2

Disable semantic subscribers at composition. Raw `EngineEvent`, TUI, JSONL, traces,
permissions, and sessions remain intact. Additive trace events can be ignored by older
readers.

### Phase 3

Start with `--accessibility standard` or remove the global presentation preference. A
screen-reader adapter failure prints the exact fallback command and preserves the session.

### Phases 4-5

Disable individual detectors or experience retrieval. Never remove stored evidence or
change the primary engine result while rolling back advice.

### Phases 6-7

Stop the foreground watcher or disable speech. Existing interactive operation remains
the recovery path. No destructive migration is required.

## Migration plan

Settings changes are additive and parsed with defaults. No startup rewrite is required.
If a normalized settings rewrite is later desirable, it must be best-effort: write a
candidate, read it back, verify equivalence, atomically replace, and warn with recovery on
failure. Never abort boot for this optional improvement.

Trace schemas are additive and versioned. State can be rebuilt from supported trace
versions through adapters; an unknown semantic event is skipped with a bounded warning.

## Runbook

### Screen-reader adapter fails

1. Preserve the active session and trace.
2. Print one plain stderr sentence naming the adapter and fallback command.
3. Use `athena --accessibility standard --continue` for interactive recovery; use
   `athena exec --output jsonl` for non-interactive recovery.
4. Capture OS, terminal, AT, and Athena versions without secret/session content.

### Blocking announcement/permission mismatch

1. Deny the action safely.
2. Emit a fatal semantic-adapter diagnostic and preserve engine state.
3. Do not continue queued mutations.
4. Reproduce through the deterministic permission sequence fixture before release.

### Watcher backend fails

1. Mark the watch unavailable, never the entire Athena boot.
2. Warn once with watch ID, backend, and recovery/stop command.
3. Keep the last working watch definition unchanged.
4. Require a real successful probe before reporting available again.

### Announcement noise regression

1. Disable the offending detector, not the whole accessible presentation.
2. Add the observed trace sequence as a no-announcement fixture.
3. Tune deterministic policy; do not add a background summarization model call.

## Publishing gate

Do not push or publish until Nico explicitly says "push it" or "go live." Before any
push, run all four repository gates on the exact committed state. Manual accessibility
matrix results are an additional product release gate, not a substitute.
