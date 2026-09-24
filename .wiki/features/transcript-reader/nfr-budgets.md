# Reliable Transcript Reading — NFR Budgets

> [Objective overview](00-overview.md) · [PRD](prd.md)

## Performance

- The fullscreen transcript renders a bounded row window and must not render the full session for every streamed text delta.
- Search target: p95 under 100 ms for a 5 MiB active-session fixture on a documented local development machine; measure before adding an index.
- Search output is paged, with excerpts capped at 500 display characters per match and a default page of 50 results. If implementation needs different bounds, justify them with terminal usability and test evidence.
- No new network calls, provider tokens, or recurring background work.

## Accessibility and terminal behavior

- All reading and search actions are keyboard reachable.
- Fullscreen mode handles PageUp/PageDown and Ctrl+PageUp/Ctrl+PageDown for transcript navigation. Mouse wheel and Home/End remain unavailable at Ink's current input seam.
- Fullscreen transcript paging does not conflate transcript text with semantic status announcements.
- Non-interactive output has no cursor-control or alternate-screen sequences.

## Privacy and storage

- Search content stays local and is not added to telemetry.
- No persistent duplicate transcript store. Any derived index must be rebuildable and follow source deletion.
- Session records remain complete; viewport virtualization changes only the rows rendered at one time.
