# Tasks, rollout and rollback

[Overview](00-overview.md) | [Evaluation](evaluation.md)

Stage 1 reconciliation is integrated; this table records the broader plan, not proof that every later stage has passed. Live evaluations and new data scopes need separate approval. Product owner: Nico. Engineering and review roles are proposed responsibilities, not assignments to people.

| ID | Task / owner role | Depends | Completion evidence |
|---|---|---|---|
| JEV-01 | Engineering: branch reconciliation inventory | None | Fresh refs, clean/dirty inventory, minimal dependency closure, reviewed overlap map preserving main's journal/library/investigation and existing continuity source boundaries. |
| JEV-02 | Engineering + independent reviewer: integrate existing optional decision boundary | 01 | One `src/decision` client, pinned baseline, shared-controller parity, existing fixtures/tests preserved. No new payload class or threshold change. |
| JEV-03 | Privacy/security review with owner: approve each feature's payload scope | 01 | Field-level DTO list, TypeSafe destination, purpose, retention/region/account-tier facts and owner decision. Denied scopes remain local/off. No implied approval from key presence. |
| JEV-04 | Engineering: root budgets, versioning, strict validation and lifecycle | 02 | Single accounting/reservation path, exact typed contracts, abort/late-result tests, privacy flags, diagnostics and content-free metering; no boot probe. |
| JEV-05 | Evaluation lead: label frozen P1 corpus and baseline | 01,03 | Independent train/calibration/holdout split by template; adjudicated labels, dataset hashes, fixed metrics/cutoffs, measured current baseline. |
| JEV-06 | Engineering: workflow/skill hint shadow adapters | 03,04,05 | Current-request workflow plus approved catalog metadata only, stable-ID suggestions, no tool filtering or automatic execution, P1 limits honored. |
| JEV-07 | Evaluation + owner: explicitly approved synthetic live comparison | 04,05,06 | Capped spend and fields approved before calls; complete result receipt comparing pinned baseline/candidate, no private history uploads. |
| JEV-08 | Owner + engineering: opt-in advisory pilot | 07 | Gate pass, visible scopes/status, TUI/exec/screen-reader/voice checks, measured benefit, kill-switch and rollback rehearsal. No representative-history dogfood unless separately resumed. |
| JEV-09 | Evaluation: justify each P2 module | 08 | Existing misses and local baseline, explicit approved payload class, frozen labels and causal downstream benefit; drop module if no improvement. |
| JEV-10 | Engineering: bounded retrieval/evidence/triage adapters, one at a time | 03,04,09 | Domain-specific contracts and unchanged provenance/promotion/verification gates; separate feature flags, per-module evidence receipt. |
| JEV-11 | Release reviewer: final documentation and integrated gates | Each enabled module | Current architecture/wiki/credential/telemetry/test docs, exact-tree four gates and CI matrix, approved publication scope. |
| JEV-12 | Owner + evaluation: representative continuity history review | Explicit owner resumption | Enough diverse archive, local review plan and destination approvals; earlier deferral remains until then. Not a prerequisite for paperwork or synthetic P1 research. |

## Phased rollout

**Stage 0: documents only, current outcome.** Keep existing code and settings untouched. No key creation, benchmark, activation, scheduled follow-up, branch merge, build, push or deployment.

**Stage 1: reconciliation integrated.** Keep old current-request path and gate semantics, with new modules off. Preserve easy return to old local fallback. Recheck overlapping source and source-linked memory safety rather than trusting historical gates.

**Stage 2: offline fixtures and synthetic shadow.** First replay fake transports with network impossible. Only after approved live experiment may synthetic state reach TypeSafe. Shadow output is observed as scalar decisions, cannot influence task behavior or durable memory, and does not mean zero privacy impact: a live shadow call still transmits data.

**Stage 3: explicit opt-in P1 pilot.** Enable one feature at a time for the owner with approved scopes and budgets. Suggestions remain advisory. Review accepted errors, abstentions, no-fit rates, task outcomes and latency, not a manually selected highlight reel. An initial 100 eligible-turn pilot is a sampling checkpoint, not proof of population accuracy. No background watcher or automatic repeated paid benchmark.

**Stage 4: separately gated P2 trials.** Only after concrete P1 benefit and field-level authorization. Never transfer the legacy global default to new historical/code/skill payload classes. A user who declines a scope retains ordinary Athena behavior without repeated prompts.

**Stage 5: release only within a later approved publication request.** Evidence receipt and exact code gates before commit/push; topic branch and required CI before merge; deployment is a separate action. No claim that a local source branch is installed or available on another machine without verifying it.

## Stop and rollback

Immediately disable the affected feature for privacy leakage, permission bypass, wrong/stale source accepted as verified, high-confidence consequential mislabel, unexpected model identity, spend escape, repeated timeout or meaningful task regression. Broad kill switch stops dispatch, aborts active transport and discards late results; cache cleared; local route remains usable. Feature-specific rollback may preserve legacy intake only if the incident does not affect the shared transport or payload boundary.

Rollback means reverting feature configuration/code to a known reviewed version, not deleting sessions, candidate memories, canonical evidence or the existing index. Do not auto-rewrite historical speech-act events after a model upgrade. Review suspect derived candidates through existing source-linked correction/rejection controls. Vendor payload deletion, if needed, is a separate owner-directed process with no guarantee inferred from local removal.

Never uninstall dependencies, reset worktrees or replace personal settings as a cleanup shortcut. Preserve user's edits and active sessions. Document incident, version, impact, unknown usage/exposure, recovery performed and remaining owner action. Re-enable only after fresh regression evidence and scope review.

## Open decisions that block specific future stages

- Integration strategy and final branch ownership: resolve before JEV-02, not by overwriting current main.
- Field-level privacy scope, actual retention tier and account limits: resolve before any new live payload class.
- Whether 1.14 yields actual project benefit: synthetic side-by-side first, not an automatic upgrade.
- Representative real-history review: explicitly deferred; resume only with owner direction.
- New feature default policy: proposed off. Changing it requires a release decision and permission review, not an inherited schema default.
