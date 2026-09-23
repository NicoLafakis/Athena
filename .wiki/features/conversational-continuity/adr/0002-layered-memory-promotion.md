# ADR 0002: Separate Episodes from Durable Semantic Memory

**Status:** Accepted
**Date:** 2026-09-23
**Parent:** [Conversational Continuity overview](../00-overview.md) ·
[PRD](../prd.md)

## Context

Conversation includes transient context, questions, hypotheticals, preferences, decisions,
and corrections. Treating every message as a durable fact creates false memories; relying
only on session history makes durable context expensive to retrieve and easy to miss.
Current `Memory`, `ExperienceStore`, RunTrace, journal, and governed learning have
different scopes and authority.

## Decision

Separate working state, source-linked episodes, semantic memories, and time rollups.
Episodes preserve what happened; rollups summarize a bounded interval and link to source
episodes; semantic memories express reusable claims with scope, confidence, speech act,
validity, lifecycle, and supporting source references. Explicit “remember this” requests
may promote immediately. Inferred memories remain candidates until supported across
independent episodes, contradiction-checked, sensitivity-reviewed, and reviewable.

Extend the existing memory-file/tool lifecycle for durable user memories. Do not repurpose
task-learning claims or create a second unstructured durable-fact store. Active runtime
truth and current repository state always outrank historical memory for current-state
questions.

## Consequences

- Memory records must distinguish observed time from valid time and retain source links.
- Tentative/conditional language and corrections need explicit lifecycle representation.
- Rollups cannot be used as standalone evidence; source retrieval is part of exact recall.
- Promotion thresholds need deterministic tests and later dogfood calibration.
- The memory-hygiene design must be updated to carry continuity source/validity metadata
  when that work is implemented.
