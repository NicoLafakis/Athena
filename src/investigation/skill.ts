export const investigationSkill = {
  name: 'source-investigation',
  description: 'Bounded source investigation with revision-linked observations, competing hypotheses, and honest completion checks.',
  instructions: `# Source investigation

Use Investigation for an explicit source-code investigation. Read/Grep/Glob and Diagnostics remain the existing navigation tools. Do not install REA or a provider, or execute target code through this skill.

1. Start with a precise question and at most 16 project-relative files. Include the relevant dependencies. The server records Git HEAD when available plus the exact file hashes, including dirty source. Scope is finite; omitted files and entry points remain outside the proof.
2. Use Investigation read to retain actual Read results with file/line locations and stable evidence IDs. Plain prose, search hits, comments, names, and hashes do not prove behavior. Repeated reads of the same bytes keep the same evidence identity; overlapping ranges from the same file are correlated.
3. Use note only for derived or inferred interpretations, citing existing evidence IDs and limitations. These notes can never become observed evidence. Keep at least two competing hypotheses and a discriminating test for each.
4. Submit the strict result contract: hypotheses [{id,statement,supports,counterevidence}], claims [{id,statement,scope,evidenceIds,counterevidenceIds,testIds}], tests [{id,hypothesisId,provider,observationId?,contains,expect}], unknowns [{id,question,requiredProvider,evidenceIds}]. Use the returned version as expectedVersion for note/submit. Never supply status, confidence, or complete.
5. The only supported tests are source-text literal present/absent predicates within a nonempty observed line selection. A pass covers those exact predicates, not the author's free-text interpretation, reachability, causality, runtime behavior, or external effects. Unit/runtime/external providers are absent in this phase; request them explicitly to record unsupported results. A unit result cannot establish runtime or external behavior.
6. Complete and inspect result. Unknowns and counterevidence stay explicit and block completion. Submitted predictions and required evidence cannot be discarded or weakened. Unknown resolution is deferred; use a new investigation with fresh evidence after resolving an unknown or changing predictions/scope. Missing/unreadable/binary/oversized input cannot pass. Redacted or truncated selections cannot pass. Changed HEAD or scoped file content makes old claims stale; start a new investigation rather than transplanting evidence.

Evidence is local, versioned, and reloadable in the same canonical project. Ledger and run-trace hashes establish integrity only. Report each failed, unsupported, unknown, contradicted, or stale claim and the required next observation. Do not call incomplete behavior verified. For durable Agent delegation, use shared workspace isolation: temporary worktree namespaces cannot be resumed by the parent or a later temporary worktree. This skill creates no additional harness.`,
}
