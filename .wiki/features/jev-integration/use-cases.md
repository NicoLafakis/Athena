# Jev use-case portfolio

[Overview](00-overview.md) | [Design](design.md)

These are project-specific design choices, not vendor performance claims. A question ID is a stable application key; instructions must state the whole question. A useful output changes one bounded advisory decision. Every row must beat its named local baseline to graduate.

| Priority and use | Actual Athena seam | Typed question and bounded state | Consumer, fallback and boundary |
|---|---|---|---|
| P0 retain recall routing | Continuity branch `src/decision/jev.ts`, `src/continuity/answer-recall.ts` | Existing seven-option Choice against current redacted request only. | Existing local source-verified retriever; abstain to local explicit-recall path. No historical text sent to Jev. |
| P0 retain speech-act intake | Branch engine and `src/continuity/jev-events.ts` | Existing nine-option Choice in the SAME request. | Source-linked candidate evidence only. No automatic memory truth, deletion, promotion or commitment creation. |
| P1 workflow hint | `src/harness/controller.ts`, `src/engine/loop.ts` | Choice: explanation / investigation / implementation / review / planning; companion Noul: does one listed workflow fit the outer request? Current redacted request only. | Suggest a prompt/workflow, never execute tools or replace explicit user instructions. Baseline is no hint plus generative model's selection. Uncertain/mixed requests use ordinary model handling. |
| P1 skill suggestion | `src/tools/skill.ts`, `src/brain/plugins.ts`, prompt assembly | Per-candidate Score with levels unrelated / incidental / directly useful; Noul: does the request need a skill? State = current request plus locally eligible, approved skill metadata. | At most one suggested stable skill ID, user-named skills override. Resolve ID against current trusted roster before load. Baseline current full roster. Do not hide unrelated tools or bypass skill-root checks. |
| P2 experience/guidance ranking | `src/experience/retrieval.ts` | Relevance Score for bounded eligible records; optional Noul for contradiction with explicit current constraint. | Rerank only after active/reviewed/project/age/confidence filters. Deterministic current ranking on unavailable or invalid judgment. No scope expansion, freshness change or learning promotion. |
| P2 project librarian recall | `src/library/runtime.ts`, `core.ts` | Noul: does this verified candidate address this request? Small query plus approved public-source note excerpts only. | Rerank within existing category-key candidates, never add unverified notes. Preserve four review stages, committed sources, checks, quarantine and revision-controlled rollback. Baseline category-key ranking. |
| P2 claim-support preflight | `src/investigation/verification.ts` and investigation tool output; journal synthesis review | Separate Nouls: does cited passage support narrow claim; does passage contradict claim; is important uncertainty missing? State contains one claim and approved evidence excerpts with opaque IDs. | Flag for generator/reviewer, not `complete=true`, executed test success, source freshness or proof. Baseline deterministic provenance plus human review. Missing support remains unknown. |
| P2 learned-candidate review triage | `src/learning/evaluation.ts`, `promotion.ts` | Independent Scores for clarity of proposed change, plausible relevance to observed failure, and evidence sufficiency on sanitized candidate metadata. | Prioritize review queue only. Baseline FIFO/manual review. Never alter held-out tests, green gates, promotion signatures, canary or rollback authority. |
| P3 journal/continuity semantic review | `src/journal/consolidation.ts`, branch candidate pipeline | Noul per candidate pair: same proposition? explicit correction? Use approved minimal excerpts only. | Suggest links/contradiction review, never merge/delete memories or turn tentative language into fact. Baseline exact local matching. Block until separate historical-data scope approval. |
| P3 repeated-failure/task attention | `src/interaction/detectors/` | Score whether sanitized current failure summary resembles earlier failure category. | Optional review hint after existing deterministic detectors. Baseline repeated-failure/budget/work-aggregation detectors. No automatic retry loops, run completion, cancellation, alert schedule or suppression of existing warnings. |

## How far to take each

P0 is branch reconciliation, not a new feature. P1 is the first expansion candidate because it can remain current-request-only except explicitly approved skill metadata. P2 is justified only where measured misses justify added cost and a new payload class. P3 stays research/backlog unless P1/P2 evidence establishes need and privacy scope is approved. A useful recipe elsewhere is not enough.

Skill suggestion uses a local shortlist before network evaluation: max 12 metadata candidates. A second call is permitted only if full descriptions for the top three add information that did not exist in the first state. Do not force two calls per turn. Explicit `/skills`, exact skill names and deterministic file-extension matches remain fast local paths. Do not prune the generative model's full available capabilities based solely on Jev.

Retrieval suggestions must preserve contradictory evidence instead of maximizing agreeable text. A negative Jev support label cannot erase counterevidence, a correction, an explicit user memory or a failed verification receipt.

## Deliberately rejected or deferred uses

- **Permission/trust/approval, security bypass or protected-path decisions:** never. A classifier cannot grant an action, reinterpret consent, relax ResourcePolicy, authorize MCP, or identify a speaker as an approver.
- **Secret detector as sole upload gate:** never. Shared redaction and explicit data scopes remain authoritative; probabilistic absence of secrets proves nothing.
- **Patch generation, summaries, final answers, multi-step plans or root-cause reasoning:** use existing generative models and source investigation, not a chain of Jev choices pretending to generate text.
- **Math, token counts, cost accounting, dates/timezones, source hashes, JSON/schema checks, exit codes and literal predicates:** code owns exact computation.
- **Model/provider auto-selection:** defer until representative task-outcome and cost evidence exists; Jev cannot raise budgets or substitute a provider without user's configuration. Static capability rules remain first.
- **Context compaction/deletion:** Jev may later advise relevance but cannot decide what canonical history to destroy. `ContextManager` keeps existing compaction contract; summary generation remains generative.
- **Tool argument construction or agent dispatch:** no executable authority. A future suggestion must still pass registry, schema, parent gate, isolation and all policy checks.
- **Screenshots, Box, audio, live voice control and computer use:** no new payloads or actuator work. Computer-use remains a separate design. Existing voice permission validation must never become Jev classification.
- **Autonomous memory promotion, account settings, watchers, schedules, notifications, deployment or learning self-modification:** outside this feature's authority.
