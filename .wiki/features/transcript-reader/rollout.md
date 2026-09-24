# Reliable Transcript Reading — Rollout and Recovery

> [Objective overview](00-overview.md) · [PRD](prd.md)

## Release shape

No data migration or feature flag is planned. Ship only after the terminal prototype and the required real-terminal checks pass. Make terminal-native append-only reading the normal interactive behavior. Keep the alternate-screen fullscreen mode explicitly selectable during the transition if it remains supported.

## Before release

- Confirm all four repository gates pass on the final tree.
- Verify scrollback in Windows Terminal/PowerShell while output is actively streaming and after completion.
- Verify redirected output contains no terminal control sequences.
- Verify active-session search for stored user, assistant, thinking, and tool blocks, plus no-results and high-match cases.
- Confirm search output and logs do not persist queries or excerpts outside the existing session record.

## Recovery

If append-only mode corrupts prompts, duplicates streamed text, or fails to preserve history, restore the last working presentation selection and retain the existing fullscreen path while the defect is fixed. Do not clear or rewrite session files as part of rollback. Search can be disabled independently if it returns incorrect or unsafe excerpts; existing session records remain unchanged.

## Data changes

None planned. If implementation adds a derived index, it must be rebuildable from session records and removable without changing conversation data. A migration plan is not applicable unless that decision changes.
