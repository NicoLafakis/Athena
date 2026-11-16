# Jev integration across Athena: planning overview

**Date:** 2026-11-16
**Status:** Stage 1 reconciliation approved and in progress in an isolated worktree. New scopes, activation, live or paid evaluation, and deployment remain outside this approval.
**Tier:** 3, external decision service and cross-cutting harness behavior.
**Project:** Athena terminal coding-agent harness on Helios.

## Decision in one paragraph

Keep Jev as an optional, typed advisory service beside the generative model, not a second agent, permission engine, truth source, or memory store. Reconcile the already-built continuity integration before adding another client. Prioritize bounded current-request classification and skill suggestions, then evaluate evidence/retrieval assistance only behind separately approved data scopes. Deterministic code owns authority, arithmetic, provenance, budgets, freshness and executed verification. Generative models still write, explain, reason and produce patches.

## Verified starting point

The named checkout is `C:\programming\nicos-apps\Athena`, clean `main` at `5257b318e36d09c7629b6371a5f8c0be2720877a` when inspected. It has no Jev implementation or SDK dependency. The clean local `codex/conversational-continuity` worktree is at `4e019402022afac24614e5f4f3f07150842977bc`, matching its locally cached origin ref. That branch DOES contain source-level Jev integration and prior synthetic evaluation documentation. Main and that branch are divergent, 37 and 33 exclusive commits respectively, from merge-base `50e906be48b83e861f87bfa39e544343cf8be677`. Cached origin equality does not prove the server has not changed. No fetch, checkout, merge, credential read, install, runtime launch or live inference was performed for this plan.

The current main controller additionally composes the journal, source investigation and project librarian. A wholesale replacement with the older continuity controller would lose later work. The integration must be reconciled, not copied over it. The installed `dist` binary was not tested and is not evidence of either branch's activation.

## Package map

- [Existing implementation and reconciliation](existing-integration.md)
- [Use-case portfolio and exact decision boundaries](use-cases.md)
- [Architecture and operational budgets](design.md)
- [Privacy, security and authority](privacy-and-safety.md)
- [Evaluation and acceptance gates](evaluation.md)
- [Dependency-ordered tasks and rollout](tasks-and-rollout.md)
- [Evidence and official sources](sources.md)

## Product outcomes and non-goals

Success means fewer irrelevant skill loads, better source-linked recall or evidence selection, and fewer unnecessary expensive reasoning calls, without reducing task success or weakening safety. A cheaper classifier that adds delay, hides counterevidence or sends more private material is not a success.

This is not a request to use Jev everywhere. It does not authorize a new vendor key, live calls, telemetry export, historical transcript upload, source-code upload, automatic personal-memory promotion, model upgrades, shell execution, CI changes or production enablement. Existing branch behavior is described as evidence, not reauthorized here. All proposed numeric targets below are release criteria, not measured results.

## Priority

1. Preserve and reconcile existing recall/speech-act boundaries.
2. Measure current-request workflow hints and eligible skill suggestions in shadow mode.
3. Consider project-local guidance ranking and evidence-quality assistance only after privacy approval and demonstrated need.
4. Keep security classification, autonomous scheduling and visual control out of the critical authority path. Reject uses that code can calculate exactly.
