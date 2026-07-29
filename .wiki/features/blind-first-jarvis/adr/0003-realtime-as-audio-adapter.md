# 0003. Realtime is an audio adapter around Athena

**Status:** Proposed
**Date:** 2026-07-29
**Serves:** [Direct-harness voice upgrade](../direct-harness-voice.md)

## Context

The first working voice composition proved local wake detection and paid Realtime audio,
but placed a small OpenAI conductor in front of Athena. The user therefore conversed with
that proxy, which could later delegate work to a spawned Athena child, rather than using
voice as a direct surface over the harness.

## Decision

Realtime will interpret post-wake audio and speak authoritative results. Every work turn
will enter one shared Athena harness session through a bounded `submit_turn` contract.
Athena alone owns reasoning, tools, permissions, session state, traces, and claims about
work. `athena voice` will own that harness session directly; controlling an independently
running TUI through authenticated local IPC is deferred.

## Alternatives considered

- Keep the conductor/delegate bridge: rejected because it preserves competing assistant
  behavior and indirect session ownership.
- Make Realtime the coding agent: rejected because it duplicates and bypasses Athena.
- Spawn `athena exec` for every request: rejected because it adds lifecycle/latency and is
  not a first-class live harness surface.
- Build active-TUI IPC first: rejected because it adds authentication, routing, and
  single-writer risk before the direct voice-owned session is proven.

## Consequences

- Voice, keyboard exec, and later presentation adapters must share a harness-session
  controller rather than fork engine composition.
- Realtime tool calls become untrusted input/control requests, not proof of execution.
- The existing permission and semantic interaction planes remain authoritative.
- A later active-TUI controller must preserve one writer through authenticated local IPC.
- OpenAI provider/model changes can be isolated behind the audio/intent adapter.
