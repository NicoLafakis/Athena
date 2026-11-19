# Athena — Harness Consolidation & Structural Optimization Plan

**Audited:** 2026-11-19
**Baseline Commit:** `5257b31` (`main`)
**Companion Doc:** [SUGGESTED_REMEDIATION.md](./SUGGESTED_REMEDIATION.md)
**Intent Reference:** [ARCHITECTURE.md](./ARCHITECTURE.md) (single session composition in `HarnessSessionController`, shared semantic plane, unified safety/budget rails, bounded learning/memory)

---

## 1. Relationship to `SUGGESTED_REMEDIATION.md`

**Execution Order:** Run [SUGGESTED_REMEDIATION.md](./SUGGESTED_REMEDIATION.md) **first**, then execute this plan.

Where items directly overlap with `SUGGESTED_REMEDIATION.md`, treat them here as a **double-check verification gate** confirming the remediation landed cleanly before applying any remaining harness-level delta:

| This Doc | `SUGGESTED_REMEDIATION.md` | Role in This Plan |
|---|---|---|
| **§2.1** Controller lifecycle/teardown + voice parity, **§4.1** 4x teardown, **§4.3** `gitBranch()` | **§2.3** `src/cli.ts` decomposition & `gitBranch()` dedup | **Double-Check First, Then Extend** — Verify `src/cli.ts` extraction & `gitBranch()` dedup from remediation didn't preserve duplicated teardown or leave `voice` behind; then finish controller `close()` / `submitTurn()` / plugin+staleness parity. |
| **§3.3** Five-store context budget arbitration | **§2.1** `library` suppressing `reflectionJournal` | **Double-Check First, Then Extend** — Verify the `library` vs. `reflectionJournal` precedence/composition contract + test from remediation is green; then generalize into a bounded composer covering `MEMORY.md` + `LEARNED.md` + `historicalContext`. |
| **§2.3** `athena watch` missing `ProtectedPaths` & **§3.2** uneven `redactSessionValue()` | **§1.1** IPv6 SSRF & **§3.1** `MUTATING_COMMANDS` duplicate | **Related (Safety Perimeter)** — Confirm remediation safety fixes are green; apply these independent perimeter fixes here. |
| **§2.1** Controller unification | **§3.2** `.wiki/INDEX.md` controller drift | **Double-Check & Refresh** — Confirm remediation updated `.wiki/INDEX.md` and `ARCHITECTURE.md`, then refresh if §2.1 changes controller APIs. |
| **§2.2, §2.4, §2.5, §3.1, §4.2–§4.4** (Experience→Model, Child seam & `RunBudget`, Orphaned voice modules, Trace/digest/command dedup) | *(none)* | **Net-New Optimization** — Not covered by `SUGGESTED_REMEDIATION.md`. |

---

## 2. Structural Disconnects (Unclosed Architectural Loops)

### 2.1 Unify `HarnessSessionController` Ownership Across `voice`, `exec`, `screen-reader`, and `tui`
- **Locations:**
  - `src/harness/controller.ts` (lines 603–672)
  - `src/cli.ts` (`voice` lines 1563–1665; shared path lines 1774, 1872, 1984–2296)
- **Problems Verified:**
  1. `controller.close()` only calls `endSession()` and `trace.close()`—omitting `mcp.closeAll()`, `shutdownBackgroundTasks(trace.runId)`, `interaction.detach()`, and `captureExperienceBestEffort()`. Because `athena voice` only calls `controller.close()`, voice sessions **leak MCP server processes and background tasks** and never capture experience.
  2. `stalenessBootWarnings()` (`cli.ts:1774`) and `loadPluginRuntimeExtensions()` (`cli.ts:1872`) only run after `voice` returns (`cli.ts:1680`), so voice silently drops plugin MCP servers, plugin hooks, and staleness warnings.
  3. `controller.submitTurn(prompt)` records the prompt on `trace` but **never calls `interaction.recordUserObjective(prompt)`**. Because `guidanceForRepeatedFailure` (`controller.ts:299–303`) returns `[]` when `objective` is empty, repeated-failure guidance is silently disabled in voice mode unless the model calls `StatusUpdate`.
  4. `cli.ts:1647` passes `loadConstitution(paths)` instead of `loadConstitution(effectivePaths)` to the Realtime voice persona.
- **Pre-Flight Double-Check (from `SUGGESTED_REMEDIATION.md` §2.3 & §3.2):**
  - Confirm `src/cli.ts` subcommand extraction did not copy-paste teardown blocks into new `src/cli/commands/` files.
  - Confirm `gitBranch()` is already deduplicated into a single shared helper.
  - Confirm `.wiki/INDEX.md` and `ARCHITECTURE.md` reflect the current `HarnessSessionController` callers.
- **Remediation Method (Remaining Harness Delta):**
  1. Add a shared session-bootstrap helper (e.g., `prepareSessionEnvironment()` in `src/harness/controller.ts` or `src/cli/session-bootstrap.ts`) that resolves trust, `effectivePaths`, settings, plugin runtime extensions, and staleness warnings once for **all** surfaces (`voice`, `exec`, `screen-reader`, `tui`).
  2. Have `controller.submitTurn(prompt, sourceRef)` call `this.interaction.recordUserObjective(prompt, sourceRef)` and make `exec`, `screen-reader`, and `tui` route turns through the controller (or a single `controller.runTurn()` wrapper) instead of duplicating `trace.recordPrompt` + `interaction.recordUserObjective` + `engine.runTurn`.
  3. Expand `controller.close({ reason, captureExperience })` to execute the full teardown in deterministic order (`shutdownBackgroundTasks` → `interaction.detach` → `endSession` → `mcp.closeAll` → `trace.close` → optional `captureExperienceBestEffort`), with a pre-trace-close hook/callback where `exec` computes exit codes between `mcp.closeAll()` and `trace.close()`.
- **Verification (TDD):**
  - Add lifecycle tests in `tests/harness/controller-composition.test.ts` verifying:
    - `submitTurn()` populates `interactionService.snapshot(runId).objective.value` and triggers `guidanceForRepeatedFailure`.
    - `controller.close()` invokes `mcp.closeAll()`, detaches `interaction`, kills background tasks for `trace.runId`, closes the trace, and triggers experience capture.

### 2.2 Close the Loop from `ExperienceStore` Back to the Model
- **Locations:** `src/harness/controller.ts` (lines 297–315), `src/interaction/event-adapter.ts` (lines 101–117), `src/engine/loop.ts`
- **Problem Verified:** `retrieveGuidance()` runs on repeated tool failure, but only emits an advisory announcement to the **human presentation**. The model running inside `Engine` never sees the retrieved guidance—leaving autonomous and `athena exec` runs blind to past failure recoveries.
- **Remediation Method:**
  1. Add an optional bounded callback on `EngineOptions` (e.g., `onRepeatedToolFailure?: (toolName: string) => string | null`) or allow `tool-result` post-processing to append a clearly delimited, untrusted `<experience-guidance>` note (capped at existing `charBudget: 2_048`) to the tool error result returned to the model on repeated failures.
  2. Keep the human announcement path intact so both operator and model receive the same bounded guidance.
- **Verification (TDD):**
  - Add an engine/controller test confirming that after N identical tool failures with a matching `ExperienceStore` entry, the next model call receives the bounded `<experience-guidance>` hint without persisting raw prompt text.

### 2.3 Connect `watchers` to the Semantic Plane & Fence `athena watch`
- **Locations:** `src/cli.ts` (lines 1682–1731), `src/harness/watchers/`
- **Problems Verified:**
  1. `athena watch` writes to `WatchStore` and logs to stdout, completely disconnected from `HarnessSessionController` and `InteractionService`.
  2. `cli.ts:1697` creates `new ResourcePolicy(cwd, 'workspace-write', [paths.brainDir])` **without** `ProtectedPaths`.
- **Remediation Method:**
  1. Pass `ProtectedPaths.from(settings.protectedPaths)` into `athena watch`'s `ResourcePolicy` immediately.
  2. Define the explicit integration seam for live sessions: either wire an opt-in watch subscriber into `HarnessSessionController` that feeds `WatchObservation` into `InteractionEventAdapter` as polite/assertive attention envelopes, or document `athena watch` explicitly in `ARCHITECTURE.md` as a standalone CLI primitive until background daemon orchestration exists.
- **Verification (TDD):**
  - Add a unit test verifying `athena watch` constructs `ResourcePolicy` with `ProtectedPaths` and rejects protected OS roots.

### 2.4 Fix Parent-to-Child Prompt Contradictions & Stateful Tool Leaks
- **Locations:** `src/harness/controller.ts` (lines 368–418), `src/harness/agents.ts` (lines 166–178, 366–390)
- **Problems Verified:**
  1. `controller.ts` appends `# Project librarian` (line 383) and `outputSchema` JSON-only instructions (lines 385–389) to `systemPrompt` **before** passing `systemPromptBase: systemPrompt` to `AgentOrchestrator` (line 406). `agents.ts:386` then appends `"LibraryRead and LibraryWrite are unavailable to child agents"`, giving every child agent contradictory instructions and leaking parent `--output-schema` constraints.
  2. `controller.ts:395` registers `Journal` (bound to parent `reflectionJournal` and parent `trace`) on `registry` before building `AgentOrchestrator`, while `agents.ts:177` only excludes `['Agent', 'LibraryRead', 'LibraryWrite']`.
- **Remediation Method:**
  1. Keep `baseSystemPrompt` clean (constitution + memory + projectContext + toolGuidance + skills + environment) and pass `baseSystemPrompt` to `AgentOrchestrator`. Append parent-only sections (`# Project librarian`, `outputSchema`) only to `parentSystemPrompt` passed to the parent `Engine`.
  2. Exclude `'Journal'` (and confirm whether `'Investigation'` should be excluded or given child-scoped context) in `AgentOrchestrator.buildChildRegistry()` (`agents.ts:177`), or register parent-only stateful tools (`LibraryRead`, `LibraryWrite`, `Journal`, `Agent`) on a parent-extended registry after `AgentOrchestrator` captures the shared base registry.
- **Verification (TDD):**
  - Add tests in `tests/harness/agents.test.ts` and `tests/library/integration.test.ts` asserting child prompts contain neither `# Project librarian` nor parent `outputSchema` instructions, and child registries exclude `Journal`.

### 2.5 Prune or Quarantine Orphaned Voice Modules
- **Locations:** `src/voice/context.ts`, `src/voice/session-router.ts`, `src/voice/input.ts`, `src/voice/speech.ts` (re-exported by `src/voice/index.ts`)
- **Problem Verified:** Zero runtime callers in `src/cli.ts`, `src/voice/daemon.ts`, or `src/voice/realtime.ts` (leftovers from the conductor deleted on 2026-08-13).
- **Remediation Method:**
  - Audit test coverage for those four files; if they exist solely to test the deleted conductor architecture and have no planned consumer in active `.wiki/features/` specs, delete them and their exports from `src/voice/index.ts`. (Keep `src/voice/attribution*.ts` intact since Phase 0 speaker diarization is actively tracked in `.wiki/features/speaker-diarization/`.)

---

## 3. Capability & Enforcement Gaps

### 3.1 Roll Sub-Agent Usage & Cost Into Parent `RunBudget`
- **Locations:** `src/harness/agents.ts` (lines 366–390, 424–441), `src/engine/run.ts`, `src/engine/loop.ts`
- **Problem Verified:** Each child `Engine` enforces its own independent `RunBudget` (up to $5 / 1M tokens / 50 calls *per invocation*). Child usage is emitted on `child-status` for traces/UI but **never debited against the parent's `RunBudget`**, allowing `athena exec --max-cost-usd <N>` to exceed its budget via sub-agent delegation.
- **Remediation Method:**
  1. Add a `recordChildUsage(usage: RunUsage): string | null` method on `RunBudget` that aggregates child tokens/cost/modelCalls into the parent's totals and checks parent `maxTokens` / `maxCostUsd`.
  2. Cap each child's effective `maxCostUsd` / `maxTokens` / `maxDurationMs` to `Math.min(childLimit, parentRemainingBudget)` at spawn time (`AgentOrchestrator.runAgent`), and debit actual `result.usage` on child completion so `budget-status` and `run-limit` reflect true total spend.
- **Verification (TDD):**
  - Add a test in `tests/harness/agents.test.ts` with a parent `maxCostUsd` / `maxTokens` limit showing that child usage is debited against the parent budget and trips the limit when exceeded.

### 3.2 Unify Secret & PII Redaction at the Shared Boundary
- **Locations:** `src/harness/redaction.ts`, `src/library/config.ts` (line 36), `src/journal/sources.ts` (lines 23–29)
- **Problem Verified:** `redactSessionValue()` only redacts `sk-(ant|kimi|live|proj)-...`, `Bearer ...`, and `AKIA/ASIA...`. GitHub tokens (`gh[pousr]_...`, `github_pat_...`), PEM private keys (`-----BEGIN ... PRIVATE KEY-----`), and inline `password/api_key/secret[:=]` strings are blocked by `library`/`journal` yet persisted unredacted in `sessions/`, `runs/` traces, and `agentRuns/`.
- **Remediation Method:**
  1. Expand `SECRET_PATTERNS` in `src/harness/redaction.ts` to cover PEM private-key blocks, GitHub tokens (`gh[pousr]_`, `github_pat_`), Slack/Stripe/Google key prefixes, and legacy `sk-` keys, plus optional `containsSecret(text)` helper exported from the same module.
  2. Have `library/config.ts` (`sensitiveText`) and `journal/sources.ts` (`safeText`) compose on top of `harness/redaction.ts` for secret detection while keeping their stricter domain-specific rules (PII/email/SSN/instruction-injection filtering).
- **Verification (TDD):**
  - Add redaction unit tests in `tests/harness/redaction.test.ts` (or existing session/trace redaction suite) covering PEM blocks, GitHub PATs, and Bearer/AWS/provider keys.

### 3.3 Arbitrate Context Budget Across the Five Knowledge Stores
- **Locations:** `src/brain/loader.ts` (lines 74–80), `src/harness/controller.ts` (lines 368–389, 490)
- **Problem Verified:** Five separate stores (`MEMORY.md`, `memory/LEARNED.md`, `ExperienceStore`, `JournalRuntime`, `LibraryRuntime`) compete without a unified budget: `loadMemoryIndex()` can inject up to 400k chars into the static system prompt, while `library` and `journal` collide via a `?:` ternary on `historicalContext`.
- **Pre-Flight Double-Check (from `SUGGESTED_REMEDIATION.md` §2.1):**
  - Confirm the `library.context()` vs. `reflectionJournal.retrieve()` contract and test from remediation are in place and documented in `.wiki/architecture/librarian-library.md`.
- **Remediation Method (Remaining Harness Delta):**
  1. Introduce a single bounded context composer (e.g., `composeHistoricalContext()` in `src/harness/context-budget.ts`) with explicit per-source character caps and precedence order honoring the contract verified above, extending it cleanly if `experience` hints (§2.2) are added.
  2. Enforce a combined cap on `loadMemoryIndex()` (`MEMORY.md` + `LEARNED.md`) proportional to model context window (or a safe hard cap with a truncation warning) so oversized memory files cannot silently starve conversation history.
- **Verification (TDD):**
  - Add unit tests verifying deterministic truncation/composition when multiple stores return content simultaneously.

---

## 4. Redundancy & Duplication Cleanup

### 4.1 Double-Check & Consolidate Teardown Sequences in `src/cli.ts`
- **Locations:** `src/cli.ts` (or extracted `src/cli/commands/` after `SUGGESTED_REMEDIATION.md` §2.3)
- **Double-Check:** Verify whether the `SUGGESTED_REMEDIATION.md` §2.3 split already centralized teardown or left copies across `exec`, `crashHandler`, `screen-reader`, `tui`, and `voice`.
- **Remediation:** Ensure every surface delegates to the unified `controller.close()` from **§2.1** with zero remaining inline teardown copies.

### 4.2 Reuse `readRunTrace` / `verifyRunTrace` in `src/journal/sources.ts`
- **Locations:** `src/journal/sources.ts` (lines 11–55) vs. `src/harness/traces.ts`
- **Remediation:** Replace the hand-rolled `TraceSchema` + hash-chain loop in `src/journal/sources.ts` with `readRunTrace` / `verifyRunTrace` from `src/harness/traces.ts` (passing bounded file/event limits as options on the shared reader), keeping journal's project-path identity check on top.

### 4.3 Extract Shared `digest()` and `git()` Primitives
- **Locations:**
  - `digest()`: duplicated in `src/harness/traces.ts:35`, `src/experience/compiler.ts:9`, `src/learning/promotion.ts:25`, `src/investigation/source.ts:10`, `src/journal/types.ts:11`, `src/library/core.ts`
  - `git()` / `gitBranch()`: `git()` duplicated in `src/harness/agents.ts:85`, `src/learning/promotion.ts:29`, `src/library/verifier.ts` (`gitBranch()` already targeted by `SUGGESTED_REMEDIATION.md` §2.3)
- **Double-Check:** Verify `gitBranch()` was extracted cleanly during `SUGGESTED_REMEDIATION.md` §2.3.
- **Remediation:** Expand that shared git helper (`src/harness/git.ts`) with `runGit()` for the remaining 3 `git()` callers, and extract canonical SHA-256 `digest()` into `src/harness/hash.ts`.

### 4.4 Single Source of Truth for `RESERVED_COMMAND_NAMES`
- **Locations:** `src/brain/loader.ts` (lines 22–40) vs. `src/tui/slash.ts`
- **Remediation:** Export the canonical list of built-in slash commands from one neutral location (e.g., `src/brain/commands.ts` or `src/tui/slash.ts` imported by `loader.ts`) and delete the manual `"Kept in sync"` duplicate set.

---

## 5. Recommended Execution Order (Post-`SUGGESTED_REMEDIATION.md`)

0. **Pre-Flight Double-Check (Overlap Gate):**
   - Confirm `SUGGESTED_REMEDIATION.md` §2.1 (`library` vs. `journal` contract + test), §2.3 (`src/cli.ts` split + `gitBranch()` dedup), and §3.2 (wiki/architecture docs) landed cleanly and all 4 gates are green.
1. **Wave 1 — Controller & Lifecycle Unification (§2.1, §4.1):**
   - Complete `HarnessSessionController` boot parity (`prepareSessionEnvironment`), turn objective recording (`submitTurn`), and unified teardown (`close()`), eliminating any teardown duplication surviving the `src/cli.ts` split and fixing `voice` leaks/missing plugins/broken repeated-failure guidance.
2. **Wave 2 — Sub-Agent Isolation & Budget Integrity (§2.4, §3.1):**
   - Separate `baseSystemPrompt` from parent-only suffixes, strip `Journal` from child registries, and debit child `RunUsage` against parent `RunBudget`.
3. **Wave 3 — Shared Safety & Context Rails (§2.2, §2.3, §3.2, §3.3):**
   - Pass `ProtectedPaths` into `athena watch`, strengthen `redactSessionValue()`, close the `ExperienceStore` → model feedback loop (§2.2), and generalize the verified `library`/`journal` contract into a bounded multi-store context composer (§3.3).
4. **Wave 4 — Hygiene & Primitive Consolidation (§2.5, §4.2–§4.4):**
   - Remove orphaned pre-refactor voice modules, reuse `verifyRunTrace` in `journal/sources.ts`, centralize `digest()`, `runGit()`, and `RESERVED_COMMAND_NAMES`.
