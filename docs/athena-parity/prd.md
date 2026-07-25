# Product Requirements

## Problem

Athena began as a strong interactive coding-agent kernel, but its safety boundary,
automation contract, extension semantics, durable run lifecycle, and learning
evidence were too narrow to support a credible parity or self-improvement claim.

## Users

- An operator using Athena interactively in trusted and untrusted repositories.
- An automation author invoking Athena from CI or another agent.
- An extension author packaging skills, agents, hooks, MCP, commands, or app metadata.
- A maintainer evaluating and promoting an improvement candidate.

## Goals

- Give the interactive and headless paths the same engine and trace semantics.
- Make every loop and large output bounded.
- Prevent repository content from gaining host execution authority before trust.
- Make sessions, children, and outcomes reconstructable from durable state.
- Evaluate improvement candidates against isolated baselines and protected held-out cases.
- Keep promotion human-gated, signed, canaried, and reversible.

## Non-goals

- Reproducing proprietary account, cloud, IDE, desktop, or marketplace services.
- Silently updating Athena or allowing an agent to replace its running binary.
- Treating one successful run or one stored memory as proof of improvement.
- Providing a built-in browser/computer-control runtime in this release.

## Acceptance

- Every requirement in [requirements.md](requirements.md) is complete, explicitly
  partial, or explicitly excluded with rationale.
- Deterministic quality gates pass on Node 20 and 22 across Linux, Windows, and macOS CI.
- The checked-in held-out suite contains at least five protected cases.
- A learning candidate cannot be promoted without intact trace provenance, a
  positive paired lower-confidence bound, no safety regression, and human approval.
