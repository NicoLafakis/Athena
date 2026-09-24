# Conversational Continuity — Objective Overview

**Tier:** 3 — major / high trust impact
**Date:** 2026-09-23
**Status:** planning; linked-episode storage choice confirmed
**Product owner:** Nico

## What was asked

Make Athena able to sustain a relationship and conversation across turns, projects, days,
weeks, months, quarters, and years. She should recall what happened and why, quickly, while
preserving the context in which each thing was said or done.

## What it really serves

Athena should be a continuous conversational partner, not a project-scoped task runner
that forgets the person as soon as a session or repository changes. She must connect the
present conversation to the right earlier episode, distinguish a passing thought from a
decision or enduring preference, and make uncertainty or changed circumstances clear.

## Load-bearing invariant

**Every recalled or promoted memory remains linked to its originating context and source.**
Summaries and long-term facts are derived views, never replacements for source episodes.
When Athena cannot retrieve adequate evidence, she says so instead of filling gaps with
plausible-sounding recollection.

## Twenty moves ahead

- **Next wants:** “What did we talk about earlier?”, cross-project recall, active
  conversational threads, and “why did that change?” with the original episode available.
- **Breaks at scale / edges:** long histories, project-specific confidentiality, timezone
  ambiguity, corrections, changed facts, similar repeated events, and summaries that
  flatten uncertainty or tentative language.
- **Unlocks:** time-aware personal context, continuity of commitments and decisions, and
  evidence-backed relationship memory across Athena presentations.
- **Doors kept open:** canonical existing session records, stable source references,
  rebuildable local indexes, replaceable retrieval/ranking, and versioned summaries.
- **Doors shut:** a second raw transcript archive, unlinked “facts” treated as timeless,
  background network summarization, and model-authored recollection without evidence.

## Scope line

### Building

- A machine-local cross-project catalog of source-linked conversation episodes.
- Separate working, episodic, and long-term semantic memory behavior.
- Retrieval routed by user intent, time range, current context, project scope, evidence,
  and freshness; no requirement to load the whole archive into every prompt.
- Time-window rollups (day through year) that link back to covered episodes and can be
  rebuilt without losing source history.
- Explicit recall, remember, correct, review, and forget controls, with CLI and
  accessibility parity.

### Proposed defaults to carry into implementation

- Existing per-user session JSONL remains the canonical conversation record. The user
  selected **linked episodes**: the new index may contain bounded summaries and metadata
  with source references, not a copied transcript archive.
- Storage and retrieval are local to the machine in the first release. No cloud sync or
  cross-machine memory replication is included.
- A direct “remember this” request creates durable memory. Inferred long-term facts remain
  reviewable candidates until supported across independent episodes; tentative statements
  are not decisions.
- No automatic age-based deletion. Explicit source deletion/forgetting invalidates its
  derived records. Retention controls can be added without changing source identity.

### Dropping

- Changing existing session transcript retention or credential storage.
- Replacing the operational journal, run traces, experiential guidance, or governed
  learning stores.
- Always-on listeners, background model calls, or external memory services.
- Automatic disclosure of one project’s details while working in another without a
  relevant user request or clear personalization need.

## Caliber and package

Tier 3 because this adds a cross-project personal-memory subsystem over sensitive
conversation history, where a wrong recall, exposure, or deletion can cost user trust.
The implementation package is:

- [PRD](prd.md) · [Requirements](requirements.md) · [Technical design](design.md)
- [ADR 0001: source-linked local episodes](adr/0001-source-linked-episodes.md)
- [ADR 0002: layered memory promotion](adr/0002-layered-memory-promotion.md)
- [Test strategy](test-strategy.md) · [Threat model](threat-model.md)
- [NFR budgets](nfr-budgets.md) · [Risks](risks.md) · [Rollout](rollout.md)
- [Implementation tasks](tasks.md)

## Existing system and gap

Athena already persists resumable sessions under per-project directories in the local
brain, keeps run traces, has a free-text `Memory` tool, compiles project-scoped run
experiences, and has a separate governed-learning pipeline. These mechanisms do not
currently provide a unified time-aware conversation index across projects. The current
memory index is injected broadly into sessions, and the memory-hygiene page is a design
spec rather than implemented behavior.

This package coordinates those systems without treating them as interchangeable:
sessions are conversation history, run traces and the journal are operational evidence,
experience is prior task outcome guidance, and user memory is durable personal context.
