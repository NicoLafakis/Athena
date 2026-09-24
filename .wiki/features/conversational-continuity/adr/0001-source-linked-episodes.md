# ADR 0001: Keep Session History Canonical and Link Derived Episodes

**Status:** Accepted
**Date:** 2026-09-23
**Parent:** [Conversational Continuity overview](../00-overview.md) ·
[PRD](../prd.md)

## Context

Athena’s session files already persist redacted messages and checkpoints under the local
per-user brain, separated by project. Cross-project recall needs a global time/topic
catalog. Copying the conversation into another archive would duplicate sensitive data,
create a second deletion and retention policy, and risk divergence from the source. A
single summary cannot safely answer exact historical questions or preserve how a thought
was framed.

## Decision

Keep the existing session JSONL as the canonical conversation record. Build a local,
versioned, rebuildable continuity index of bounded episode summaries, metadata, and stable
references to source message records. Do not copy full transcripts. Time rollups are
derived caches with source coverage/digests; exact recall resolves and reads source
messages. Store the index under the local user brain and do not sync it in the first
release.

The user explicitly selected linked episodes over summaries-only or a copied searchable
archive.

## Consequences

- Cross-project recall must enumerate the local project session directories rather than
  rely on the current project’s `SessionStore.list()`.
- Source references require stable session-line IDs and project IDs, not filenames alone.
- Rebuild and session delete-to-trash maintain persistent source-suppression tombstones.
  `athena session restore <id>` explicitly restores the source and reindexes it. Semantic
  memory forget is a separate action: it clears derived semantic text, removes secondary
  source metadata, and retains only typed source identity plus minimal lifecycle metadata
  to suppress regeneration, while leaving the canonical session available for explicit
  historical recall.
- The derived index can be discarded and reconstructed; the session history remains
  untouched.
- Retrieval may need to fetch adjacent turns from source files; the latency budget must
  account for it.
