# Athena v2 — Findings & Roadmap

**Date:** 2026-07-22
**Status:** Findings verified against source; roadmap proposed for prioritization
**Repo:** github.com/NicoLafakis/Athena (`C:\programming\nicos-apps\Athena`)

v1 is complete: 15/15 tasks, 204/204 tests passing, commits through `6de7bf2`. v2 remediates and upgrades v1 — it is **not** a reinvention. The four-layer architecture (TUI → Harness → Engine → Brain) is validated and stays.

## 1. v1 assessment (what held up)

- **The four-layer split survived all 15 tasks without rework.** The engine is terminal-free and event-driven, which made the TUI task and sub-agent reuse clean.
- **The two-stage review process caught ship-blockers:** the Edit tool's `$&` replacement corruption; the hostile-hook EPIPE crash; a compaction boundary flaw (would have 400'd on long sessions) inherited from the plan itself; abort-mid-batch unpaired tool_results.
- **Invariants were adversarially tested:** permission precedence, hook fail-closed behavior (crash/timeout/signal-kill), tool_use/tool_result pairing (9 attack paths), import idempotence (33 assertions).
- **Task 15 quality-review findings were all remediated in `6de7bf2`:** top-level error boundary, contained session writes + tmp cleanup, /compact stale model, busy-turn slash guard, PermissionBridge cancelAll, parseArgs unknown-arg errors, DEFAULT_SETTINGS dedup via `SettingsSchema.parse({})`, SessionPicker guards/windowing.

## 2. Verified findings (the gaps, with evidence)

Each finding below was verified against source on 2026-07-22.

1. **No prompt caching.** `src/engine/client.ts` builds requests with no `cache_control` breakpoints anywhere; zero hits repo-wide. Yet the system prompt is assembled once per session and byte-stable (assembled once in `src/cli.ts` main(), env date frozen at startup) — i.e. perfectly cacheable today. SDK ^0.57.0 supports it. Every turn re-bills constitution + memory index + tool schemas at full input price.
2. **No extended thinking.** No `thinking` param sent (`src/engine/client.ts` stream/complete); the code listens for thinking deltas but never enables them. Not configurable; maxTokens hardcoded to 8192 (`src/cli.ts`, `src/tools/agent.ts`). *Update (Build 5, 2026-07-22): the thinking gap is CLOSED — model is now a family (`haiku|sonnet|opus|fable`) resolved via `src/brain/models.ts`, and Sonnet/Opus/Fable send `thinking:{type:'adaptive'}` + `output_config.effort` (new `effort` settings key, `/effort` command); Haiku runs bare. maxTokens is still hardcoded (P3.5 remainder).*
3. **Sequential non-Agent tool execution.** `src/engine/loop.ts`: only all-Agent batches >1 go through Promise.all; any other batch (e.g. three Reads) awaits sequentially in a for loop.
4. **Shell output not streamed.** `src/tools/shell.ts` buffers stdout/stderr into a string and resolves only on close; the TUI is dead during long commands. Background tasks likewise emit only a single completion result.
5. **Whole-summary compaction only.** `src/engine/context.ts` compact() replaces everything before a keepRecent tail (default 6) with one summary message at the 80% trigger. No graduated path — no selective pruning of stale tool_result blocks while keeping assistant reasoning.
6. **No token/cost accounting.** `src/engine/loop.ts` overwrites usage each cycle (last response wins) rather than accumulating; no session totals, no cost estimation; StatusLine shows only `ctx N%`.
7. **Skills unwired.** No Skill tool; loadSkillsIndex is used only by the /skills slash command (prints names). Skills are NOT in the system prompt at all — neither invocable nor advertised to the model. This is the largest missing piece of the ares design DNA.
8. **No automatic memory recall.** Memory = index in system prompt + manual Memory CRUD tool. No relevance-based injection of memory bodies; no reflection loop that writes memories after corrected/completed tasks.
9. **Sub-agents invisible.** `src/tools/agent.ts` gives children a fresh EngineEventBus; only final text/errors are captured for the return value. The parent TUI shows one frozen Agent tool card until return. (Per-agent model override DOES already exist via agent frontmatter `model:` — a v1 strength to build on.)
10. **Settings surface thin.** Keys: model, permissionMode, allow, deny, hooks. No maxTokens, no thinking config. Global ← project cascade works. *Update (Build 5): `effort` key added; thinking is now derived per-family from `model` rather than a separate key. maxTokens still absent.*
11. **Status line static at mount.** /mode and /model now mutate runtime state, but the bar shows stale values until restart (filed in review, deferred).
12. **'Turn aborted' string coupling** in `src/tools/agent.ts` abort classification (filed, deferred).

**Security backlog (in flight; verify against git log).** The deferred security backlog — permission path normalization traversal bypass, Bash prefix filter advisory nature, Windows process-tree kill, unbounded shell/webfetch buffering, WebFetch scheme guard, MEMORY.md reserved-name guard, settings array aliasing, `.gitignore` `!.env.example`, eslint root configs, bin shim error — is being remediated in a hardening pass on 2026-07-22. Check `git log` for the landed commit before treating any of these items as open.

## 3. The design lens for v2

The pattern across findings 1–9 is that v1 inherited the operating model's own weaknesses instead of compensating for them: re-billing static context (caching), carrying dead tool results until collapse (compaction), re-deriving knowledge (skills/memory/reflection), blindness while delegating (sub-agent events), under-thinking without a budget (extended thinking), no felt cost (accounting). v2's organizing principle: **the harness should correct for the model's makeup, not mirror it.**

## 4. v2 roadmap (remediate + upgrade, prioritized)

### Phase 0 — finish v1's own tail (already in flight)

- The hardening backlog listed in Section 2.
- Live E2E smoke against the real API — the one thing never yet proven.
- The two deferred minors: status line reactivity (finding 11) and an aborted-event field replacing the string match (finding 12).

### Phase 1 — economics & context (highest leverage, pure win)

| ID | What | Why (finding) | Sketch | Size | Risk |
|---|---|---|---|---|---|
| P1.1 | Prompt caching | #1 | Add `cache_control` breakpoints on system prompt + tools in `src/engine/client.ts`; sub-agents benefit automatically (same client). ~90% input-cost cut on cache hits, latency drop. | S | Minimal |
| P1.2 | Token/cost accounting | #6 | Accumulate TokenUsage per session in `src/engine/loop.ts` (sum, don't overwrite), cost table per model, surface in StatusLine + /cost command. Prereq for measuring everything else. | S | Minimal |
| P1.3 | Graduated compaction | #5 | Stage 1 = prune tool_result bodies older than N turns to one-line stubs (keep assistant text/reasoning); stage 2 = existing whole-summary as fallback. `src/engine/context.ts`. | M | Must preserve the tool_use/tool_result pairing invariant — reuse the existing boundary-walk logic and its tests |
| P1.4 | Output caps at source | #4 (partial), hardening | Shell/grep/webfetch caps so junk never enters the window. Part of the hardening pass. | S | Minimal |

### Phase 2 — the ares soul (differentiation)

| ID | What | Why (finding) | Sketch | Size | Risk |
|---|---|---|---|---|---|
| P2.1 | Skills in system prompt + Skill tool | #7 | Inject skills index into assembleSystemPrompt; add a Skill tool that loads a named skill's body into the transcript. `src/engine/prompt.ts`, new `src/tools/skill.ts`, registry wiring. | M | Low |
| P2.2 | Memory recall | #8 | Relevance-based recall — cheap first version: UserPromptSubmit hook or engine step that greps memory descriptions against the prompt and injects matching bodies; design seam for embedding-based recall later. | M | Low |
| P2.3 | Reflection loop | #8 | Stop-hook (or post-turn engine step) that, after corrected/multi-step tasks, prompts the model to write a feedback memory via the existing Memory tool. This is what makes Athena compound instead of reset. | M | Moderate (prompt quality determines memory quality) |

### Phase 3 — operator experience

| ID | What | Why (finding) | Sketch | Size | Risk |
|---|---|---|---|---|---|
| P3.1 | Sub-agent visibility | #9 | Forward child bus events to parent bus tagged with agentId; TUI renders nested progress lines under the Agent tool card. `src/tools/agent.ts`, `src/tui/App.tsx`, `src/engine/types.ts` (agentId field on events). | M | Low |
| P3.2 | Parallel read-only tool batches | #3 | Extend the `src/engine/loop.ts` all-Agent fast path to any batch where every tool is readOnly. | S | Low |
| P3.3 | Streaming shell output | #4 | Incremental output events from `src/tools/shell.ts`, TUI tail rendering; also feeds P3.1. | M | Low |
| P3.4 | Live status line | #11 | Make mode/model/context%/cost reactive (props → state fed by bus events). | S | Minimal |
| P3.5 | Extended thinking + settings | #2, #10 | ~~`thinking`~~ + `maxTokens` settings keys; enable thinking with budget; per-agent-frontmatter override already exists for model — mirror the pattern for thinking. **Thinking/effort landed in Build 5** (model families + `effort` key + adaptive thinking); `maxTokens` key still TODO. | S/M | Low |

### Phase 4 — platform seams (bigger bets, order by Nico's call)

| ID | What | Sketch | Size | Risk |
|---|---|---|---|---|
| P4.1 | Headless mode `athena -p "prompt"` | Biggest unlock — scriptable Athena (cron, CI, self-hosting builds, Athena-dispatching-Athena). The TTY guard from Task 15 is the front half of the seam. | M | Low |
| P4.2 | MCP client | Connect to MCP servers; ToolRegistry is already the right abstraction to mount external tools into. | L | Moderate |
| P4.3 | Checkpoint/rewind | Sessions are append-only JSONL — /rewind + session forking are file-truncation-cheap. | M | Low |
| P4.4 | LSP/diagnostics integration | Type errors fed into the loop without running gates. Furthest out, highest quality ceiling. | L | Moderate |

## 5. Explicitly not v2

- Reinventing the loop/architecture.
- A GUI.
- Multi-user/hosted anything.
- Paid third-party services (house rule: build-don't-buy).
- Sentry-class observability SaaS (banned — use logs).

## 6. Sequencing rationale

Phase 1 comes before Phase 2 because caching + accounting make every later phase measurably cheaper and measurable at all. Phase 2 comes before Phase 3 because it changes what Athena IS, not just how it feels. Phase 4 items are independent seams to pick off by appetite.
