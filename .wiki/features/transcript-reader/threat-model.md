# Reliable Transcript Reading — Threat Model

> [Objective overview](00-overview.md) · [PRD](prd.md)

## Surface and assets

- Local session JSONL and in-memory messages, which may contain prompts, code, tool output, paths, and provider-supplied thinking.
- Search query and excerpts displayed in the local terminal.
- Any derived search index, if one is introduced.

## Threats and controls

| Threat | Control |
|---|---|
| Search query or transcript excerpt leaks through telemetry or a provider call | Search remains local; do not instrument query/excerpt values and do not call a model |
| Terminal control characters embedded in tool output or session data alter the terminal | Sanitize control sequences in search excerpts and append rendering while preserving safe text; test ANSI/OSC-shaped input |
| Malformed or oversized session data causes unbounded output or memory use | Bound excerpt size and result page size; handle malformed records with a concise local error |
| Derived index outlives a deleted session | Prefer no persistent index initially; if introduced, tie it to source identity, rebuild it, and delete it with the source |
| Search implies unavailable reasoning is present | Search only stored blocks; preserve redaction markers and clearly limit claims to available content |
| Search accidentally changes the model context or session | Make search read-only and assert no provider invocation and no session mutation |

## Trust boundaries

Session content and tool output are untrusted display data. Escape terminal control sequences at the output boundary. Search matching must treat the query as a literal string, not executable regex or shell syntax.

## Residual risk

Fullscreen viewport clipping changes only rendered rows; session records and active-session search remain the complete local record.
