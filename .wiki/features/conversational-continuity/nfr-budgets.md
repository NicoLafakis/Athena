# Conversational Continuity — Non-functional Budgets

> [Overview](00-overview.md) · [Requirements](requirements.md) · [Test strategy](test-strategy.md)

## Retrieval latency

- Warm local timeline/search p95 target: **under 150 ms** for the first 10,000 episode
  records on the development machine.
- Source-context expansion p95 target: **under 250 ms** for up to 5 episodes and 8
  surrounding message records.
- Indexing adds no provider call and should not delay a user turn by more than 25 ms when
  merely detecting/indexing an append incrementally; expensive rebuild is explicit or
  bounded background local IO.
- Cold startup performs no full archive scan. A stale index degrades to available
  indexed results plus an actionable warning.

These are initial guardrails to validate on representative histories; tests use generous
regression limits across CI hosts.

The first synthetic 10,000-episode and 10,000-session-file measurements are recorded in
[the calibration snapshot](calibration.md). Warm indexed search, five-source context
expansion, and the shared CLI/slash search presenter are within their targets in that
sample; representative live-history performance remains unmeasured.

## Prompt and result bounds

- Automatic recall: at most 5 episode/fact candidates and 4,000 characters total by
  default; hard cap 8,000 characters.
- Episode summary: at most 1,200 characters. Rollup: at most 4,000 characters.
- Context expansion: at most 8 adjacent source messages per episode and a global token
  budget reserved by the engine context manager.
- The complete session archive is never added to one model request.

## Reliability

- Indexing/rebuild is idempotent, atomic, and versioned.
- Optional index failure never blocks boot, non-memory requests, or project work.
- Every surfaced memory result has valid source refs or is explicitly marked unverified.
- Zero known forgotten/tombstoned records returned after rebuild.

## Privacy and cost

- No provider/network request for capture, indexing, or ranking while optional decision
  providers are disabled; Jev is disabled by default.
- If enabled in a future Jev routing slice, allow at most one request for an eligible
  user turn, after local cheap gates. Send only the redacted current request and fixed
  choice labels; do not send retrieved history, memory text, source IDs, or project paths.
- Measure the Jev request latency, input tokens, and cost on the labeled synthetic corpus
  before setting release budgets. Timeout, rate limit, or provider error must fall back to
  local routing without blocking the turn.
- No duplicate raw transcript store or new paid service by default; an enabled Jev
  integration is a separately opted-in paid provider path.
- Logs contain no query strings, content, user facts, or project paths.
- Secret-shaped fixtures produce zero leaks in indexes, rollups, prompt context, or logs.
- Local index size is measured on representative histories; an initial target is under
  10% of source session size, excluding source files themselves.

## Accessibility

- All list/show/review/forget actions work via keyboard and append-only line presentation.
- No essential memory state is communicated only by color, spatial placement, animation,
  or TUI-only controls.
- Ambiguous recall, source missing, and rebuild-needed messages identify the situation
  and an available action in plain text.
