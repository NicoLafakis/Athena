# Reliable Transcript Reading — NFR Budgets

> [Objective overview](00-overview.md) · [PRD](prd.md)

## Performance

- Finalized transcript rendering is append-oriented. It must not rerender the full session for every streamed text delta.
- Search target: p95 under 100 ms for a 5 MiB active-session fixture on a documented local development machine; measure before adding an index.
- Search output is paged, with excerpts capped at 500 display characters per match and a default page of 50 results. If implementation needs different bounds, justify them with terminal usability and test evidence.
- No new network calls, provider tokens, or recurring background work.

## Accessibility and terminal behavior

- All reading and search actions are keyboard reachable.
- Standard mode leaves scroll controls to the terminal; Athena must not consume PageUp/PageDown while the user is reading native scrollback.
- Append-only output remains screen-reader readable and does not conflate transcript text with semantic status announcements.
- Non-interactive output has no cursor-control or alternate-screen sequences.

## Privacy and storage

- Search content stays local and is not added to telemetry.
- No persistent duplicate transcript store. Any derived index must be rebuildable and follow source deletion.
- Terminal scrollback length is user-configured; Athena guarantees session search against stored content, not unlimited terminal buffer retention.
