# Reliable Transcript Reading — Observability

> [Objective overview](00-overview.md) · [PRD](prd.md)

## Operational signals

This is a local terminal feature; no hosted service or new telemetry is justified. Do not record transcript text, thinking content, tool output, search queries, or result excerpts in logs or metrics.

Use concise local errors for unreadable session records, unsupported interactive terminal output, and search failures. Diagnostics may include operation category, session identifier only if already considered safe by existing local logging policy, elapsed time, and result count; do not include content.

## Verification signals

- Paging moves through transcript history without moving fullscreen chrome; a growing entry keeps the first visible row fixed.
- Search returns the expected fixture count by content kind and preserves chronological order.
- Redirected output emits no cursor-control sequences.
- Searches do not call a provider and do not mutate stored messages.

## Support procedure

Reproduce in the exact terminal and shell, note whether output is interactive or redirected, inspect the active row budget and scroll anchor, and compare against the viewport and App scrolling tests. Use existing session inspection/recovery procedures; do not ask users to upload private transcripts for routine diagnosis.
