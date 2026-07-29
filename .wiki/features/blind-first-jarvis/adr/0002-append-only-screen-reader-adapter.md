# ADR 0002: Use an append-only screen-reader adapter instead of adapting fullscreen Ink

**Status:** proposed
**Date:** 2026-07-29
**Serves:** [PRD](../prd.md)

## Context

Athena's fullscreen UI deliberately uses a fixed-height Ink tree, incremental rendering,
an animated busy indicator, cursor movement, popups, and an alternate-screen buffer.
Those are valuable visual affordances but are not a reliable semantic interface for
speech or Braille. Merely switching colors or adding labels would leave the user exposed
to redraw noise and hidden spatial state.

## Decision

Implement screen-reader mode as a distinct line-oriented presentation adapter:

- stable append-only output;
- no animation, cursor rewrite, alternate screen, or color-only meaning;
- explicit text prompts and keyboard choices;
- bounded on-demand details rather than unsolicited tool logs;
- the same engine, permissions, sessions, traces, and semantic state as other modes.

Selection is explicit through a CLI flag or global user preference. Athena does not
auto-detect disability or screen-reader processes.

## Alternatives considered

1. **Use `/tui classic` as the accessible mode.** Better than fullscreen, but still lacks
   semantic announcements, verbosity policy, accessible permission wording, and a tested
   contract.
2. **Retrofit ARIA-like metadata into Ink components.** Terminal output does not expose a
   browser accessibility tree controlled by Ink, so this cannot be the primary contract.
3. **Add direct text-to-speech.** Rejected as the base because it can double-speak with a
   screen reader, excludes Braille, and adds platform dependencies.

## Consequences

- The first accessible implementation does not require visual TUI changes.
- Input and permission flow need an adapter-neutral interface instead of React-only state.
- Automated output invariants become straightforward to test.
- Real terminal/screen-reader behavior still requires manual validation.
- Feature parity must be tracked so the standard TUI and screen-reader mode do not diverge.
