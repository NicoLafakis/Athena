# Existing Jev implementation: retain, reconcile, do not duplicate

[Overview](00-overview.md) | [Sources](sources.md)

## Branch facts, not main-runtime claims

Read via `git show codex/conversational-continuity:<path>` at `4e01940`:

| Existing surface | Observed behavior to preserve |
|---|---|
| `src/decision/client.ts` | Optional `DecisionClient`/`DecisionTransport`, strict caller response schema, typed decision/fallback union, abort/timeout race and content-free telemetry. |
| `src/decision/jev.ts` | Pins `jev-1.13.0`; maximum current request 12,000 characters after shared redaction; two Choices in one call: recall route and memory-relevant speech act. SDK logging off, retries disabled, 1.9-second SDK attempt inside a 2-second outer deadline. |
| `src/brain/settings.ts` | Global `jev.enabled` defaults true; project cannot override. Network setup requires environment-only `TYPESAFE_API_KEY`. Missing key or optional setup failure leaves local handling available. Invalid global settings currently revert to enabled-by-default with warning; audit this behavior before adding features. |
| `src/harness/controller.ts` | Builds one injectable router in shared composition; traces scalar outcomes/tokens; wires bounded local answer-time recall and source-linked speech-act intake. |
| `src/engine/loop.ts` | Classifies inbound user request, applies 0.98 confidence gate, excludes `none` and `continue-current` from history directives; resets ephemeral turn state. Only `preferred`, `decided`, `promised`, `corrected`, `retracted` can produce eligible source-linked speech-act events at 0.98. |
| `src/continuity/answer-recall.ts` | Jev hint selects a local source-verifying retrieval path; local explicit-recall fallback remains. Date/project ambiguity is handled locally. Bounded redacted excerpts go to the configured answer model, never Jev. |
| `src/continuity/jev-events.ts`, `schemas.ts` | Speech-act events are source-linked classification evidence, not permission to remember, supersede, delete or promote claims. |
| `package.json`, lockfile | `@typesafe-ai/sdk` pinned `0.6.0`. |
| `tests/decision`, `tests/continuity`, `bench/jev-*` | Existing transport, routing, fixtures and synthetic evaluation surfaces; reuse rather than create a parallel framework. |

Recall routes: `none`, `continue-current`, `temporal-recall`, `topic-recall`, `preference-or-fact`, `historical-decision`, `similar-work`.
Speech acts: `none`, `asked`, `stated`, `considered`, `preferred`, `decided`, `promised`, `corrected`, `retracted`.

## What the existing measurements establish

The branch's ADR 0003 and calibration page record September 24 synthetic live evaluations: recall raw exact 266/266, accepted exact 197/197 at 0.98 with 74.1% coverage; speech-act raw exact 126/126, eligible persisted-label exact 53/53 with 42.1% coverage. These are historical documentation read this session, not rerun results. They establish neither representative current-user accuracy nor an upgrade pass. A small independent holdout is still small. Representative live-history dogfood was explicitly deferred by the owner on September 24 and remains open. Do not silently restart it under this plan.

## Reconciliation procedure for a later approved implementation

1. Recheck clean status, server refs, branch tips and overlapping edits. Preserve both existing worktrees; do not reset, stash, replace files or switch the user's working branch opportunistically.
2. Produce a reviewed integration diff. The continuity branch contains about a hundred changed paths, not just a transport. Decide whether to integrate continuity as a whole first or extract a minimal dependency closure. Do not cherry-pick the client alone while leaving controller, session, source-reference or deletion contracts broken.
3. Reconcile shared `controller.ts`, `loop.ts`, settings, session events, CLI/slash handlers, source redaction and brain paths against main's later library, investigation, journal and provider changes. Retain common TUI/exec/screen-reader/voice composition. Verify child registries still exclude privileged library tools and retain fences.
4. Carry forward tests and source-linked history semantics. Preserve per-project boundaries, source digests, deletion tombstones, correction chronology, ephemeral prompt context and local explicit-recall fallback. Do not change the old 0.98 gate while performing the merge.
5. Keep the selected current-request data boundary intact. New feature flags start off even if the legacy global master remains true. Legacy enablement is not blanket permission to send skill text, source code or historical records.
6. Evaluate model/SDK upgrades as a separate change. Official docs now list 1.14 and moving aliases. Pin the old baseline until a candidate beats it on frozen project tests. Never silently switch to `jev-latest`.

## Known review questions, not claimed defects

- Response schemas check bounds and exact label maps. Add tests for non-normalized distributions, selected label inconsistent with maximum probability, and wrong question type/model provenance before using probabilities more broadly.
- Check outer deadline plus cancellation against a transport that ignores abort; no late decision may affect the next turn.
- Confirm new provider meters join run-wide limits and VMP attempt accounting without prompt logging or double-counting.
- Verify default-enabled migration and malformed settings cannot unintentionally enable newly introduced data scopes.
- The branch predates current main's later composition changes. Existing synthetic success does not resolve integration regressions.
