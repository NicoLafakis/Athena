# Athena completeness audit

**Date:** 2026-07-26  
**Auditor:** Athena (self-audit)  
**Branch:** `claude/build-athena-chatbot-GFUxN`  
**Scope:** Architecture, tools, engine, TUI, security, learning, plugins, MCP, CLI, and test/CI gates.  
**Gates run:** `pnpm typecheck` ✅, `pnpm lint` ✅, `pnpm test` ✅ (649 tests, 76 files)

---

## Executive summary

Athena is **architecturally complete and well-tested**. The four-layer design (TUI → Harness → Engine → Brain) is mature, the test suite is comprehensive, and much of the v2 roadmap has already landed (extended thinking/effort, skill tool, MCP, plugins, engine-side cost accounting, reactive status line, fullscreen TUI, worktree-isolated sub-agents).

The remaining gaps are predominantly **economic and ergonomic** — the things that determine whether using Athena feels like driving a finished power tool or an advanced prototype. The highest-leverage work is prompt caching, cost visibility, parallel read-only tool execution, smarter compaction, and a handful of TUI/CLI polish items.

**Bottom line:** fix the top 5 gaps and Athena becomes dramatically cheaper, faster, and more pleasant to use.

---

## What is already complete and strong

| Area | State | Evidence |
|---|---|---|
| **Core architecture** | Mature, terminal-free, event-driven engine; reused by TUI, headless `exec`, and sub-agents | `src/engine/loop.ts`, `src/engine/events.ts` |
| **Test coverage** | 649 tests across 76 files, all passing | `pnpm test` output |
| **CI gates** | TypeScript strict, ESLint, Vitest, build on Node 20/22 across Linux/macOS/Windows | `.github/workflows/ci.yml` |
| **Auth & providers** | Anthropic, Kimi/Moonshot, Kimi Code; credential vault + env overrides | `src/brain/models.ts`, `src/auth/wizard.ts` |
| **Trust & permissions** | Project trust by canonical path, capability digests, permission modes, resource policy | `src/harness/trust.ts`, `src/harness/permissions.ts` |
| **Sessions** | Append-only event logs, checkpoints, rewind, fork, rename, recoverable delete | `src/harness/sessions.ts` |
| **Plugins / MCP / Hooks** | Install/update/verify/remove with optional Ed25519 signatures; stdio and Streamable HTTP MCP; 12 hook lifecycle events | `src/harness/plugins.ts`, `src/harness/mcp.ts`, `src/harness/hooks.ts` |
| **Learning pipeline** | Warehouse → candidate → held-out evaluation → canary → signed promotion/rollback lineage | `src/learning/*.ts` |
| **Sub-agents** | Durable runs, follow-up/resume, worktree isolation, bounded concurrency | `src/harness/agents.ts`, `src/tools/agent.ts` |

---

## Highest-impact gaps

These are the items that most directly affect cost, latency, capability, and daily usability.

### 1. Prompt caching is barely used

Only the **system prompt** receives a `cache_control` breakpoint, and only when calling the direct Anthropic endpoint (`baseURL === undefined`). Tool definitions, the constitution, the memory index, and other stable context blocks are not cached, even though they are static and large.

- `src/engine/client.ts:85-87` marks only `system` as cacheable.
- Tools are passed through untouched: `src/engine/client.ts:89`.

**Impact:** Every turn re-bills the full system prompt and all tool schemas. Expanding caching to tools and stable context blocks is likely the single biggest cost and latency win available.

**Recommendation:**
- Cache tool definitions and the system prompt together at the start of every request.
- Add breakpoints to stable project-context and constitution blocks.
- Make cache breakpoint policy provider-aware rather than inferred from `baseURL`.

---

### 2. Cost accounting is hidden from the user

The engine already accumulates tokens, cost, cache reads/writes, and usage breakdowns in `RunBudget` (`src/engine/run.ts:7-17`). However, the TUI status bar only shows `ctx N%`, and there is no `/cost` slash command. The headless `exec` JSON envelope is the only place the data surfaces.

- `src/tui/components/StatusLine.tsx:24-29` does not display cost or tokens.
- `src/cli.ts` has no `/cost` slash handler.

**Impact:** Users fly blind on spend during long sessions. A capability as simple as "how much did that turn cost?" is missing.

**Recommendation:**
- Add cumulative cost, input/output/cache token counts, and model-call count to the status line.
- Add a `/cost` slash command that prints session totals and per-turn breakdown.
- Emit a `cost-update` event after each model response so the TUI can stay live without waiting for `turn-done`.

---

### 3. Read-only tool batches run sequentially

The engine only parallelizes batches where **every** block is an `Agent` call. Any other multi-tool batch — for example five `Read` calls issued at once — runs sequentially in block order.

- `src/engine/loop.ts:363-457` shows the sequential fallback.
- The parallel path is gated to `block.name === 'Agent'`: `src/engine/loop.ts:384-394`.

**Impact:** Common patterns like "read 5 files to understand the repo" are unnecessarily slow.

**Recommendation:** Generalize the concurrency rule to "all requested tools are read-only or explicitly concurrency-safe." Reuse the existing `mapWithConcurrency` helper and respect `maxConcurrency`.

---

### 4. Compaction is coarse and message-count based

`ContextManager.compact` replaces everything before the last 6 messages with a single summary message. It does not perform graduated pruning (e.g., stub old `tool_result` bodies while keeping assistant reasoning), and the cut point ignores actual token counts.

- Whole-summary compaction: `src/engine/context.ts:74-94`.
- Default `keepRecentMessages = 6`: `src/engine/context.ts:16`.
- Summarization prompt truncates each block to 2000 chars: `src/engine/context.ts:55-71`, `src/engine/context.ts:105-122`.
- After compaction `lastTotal` is reset to `0`, making `usedFraction()` misleading until the next API response: `src/engine/context.ts:92`.

**Impact:** Long sessions lose fine detail abruptly and spend a summarization call even when only a small amount of content is actually causing pressure.

**Recommendation:**
- Stage 1: stub tool-result bodies older than *N* turns to one-line summaries, keeping assistant text and reasoning.
- Stage 2: keep the existing whole-summary fallback for when the context window is still exceeded.
- Make the cut point token-aware rather than message-count based.
- Fix `usedFraction()` after compaction so it reflects the compacted transcript size.

---

### 5. Skills are present but not frictionless to use

Skills are loaded into the system prompt as an index, but the model must actively call the `Skill` tool to load a skill's full instructions. There is no auto-load on first mention, and the `Skill` tool description grows unbounded with the skill list.

- Skill tool description concatenates every skill: `src/tools/skill.ts:42-46`.
- Skill tool loads full instructions on demand: `src/tools/skill.ts:49-99`.
- System prompt renders only the skills index: `src/engine/prompt.ts` via `assembleSystemPrompt`.

**Impact:** Users with a library of skills will find the model often ignores them because there is no explicit nudge to load the right skill before acting.

**Recommendation:**
- Inject the most relevant skill bodies into the system prompt when the user prompt matches a skill name/description (keyword match as a cheap first pass; embeddings later).
- Cap the skill list in the tool description and summarize it.
- Add a skill-mention syntax (e.g., `@skill:review`) in the input box.

---

### 6. Sub-agents are a black box in the TUI

Child agents run with their own `EngineEventBus`. The parent TUI renders child status/text as single system-message lines, not as nested, inspectable progress under the parent `Agent` tool card.

- Child events rendered as system text: `src/tui/App.tsx:776-807`.
- Agent tool returns only final text + run_id: `src/tools/agent.ts`.

**Impact:** Delegating to a sub-agent feels like launching a process and waiting for an email instead of watching progress.

**Recommendation:**
- Forward child bus events to the parent bus tagged with `agentId`.
- Render nested tool cards under the parent `Agent` card in the transcript.
- Show agent status, elapsed time, and current tool in the TUI.

---

### 7. Shell and web tools are capped and brittle

- Shell output is hard-capped at 30,000 characters with no streaming escape hatch. The description claims output streams, but the stream is bounded by the same cap: `src/tools/shell.ts:21`, `src/tools/shell.ts:54-77`.
- WebSearch scrapes DuckDuckGo HTML directly with no fallback engine: `src/tools/websearch.ts:43-48`.
- WebFetch silently upgrades `http:` to `https:`: `src/tools/webfetch.ts:124`.
- Grep output is also capped at 30,000 characters: `src/tools/grep.ts:13`.

**Impact:** Long builds, large searches, and web lookups give truncated or brittle results.

**Recommendation:**
- Add a "stream to file" mode for shell so very large output can be captured and summarized.
- Add a fallback search engine path (e.g., Bing or Brave with an API key) and handle DDG markup changes more defensively.
- Make WebFetch preserve explicit `http:` URLs or document the upgrade clearly.

---

### 8. Memory is static, not relevance-based

Memory recall is either the full `MEMORY.md`/`LEARNED.md` block injected into the system prompt, or manual CRUD via the `Memory` tool. There is no embedding search, no similarity ranking, and no automatic reflection after completed tasks.

- Full memory index loaded into system prompt: `src/brain/loader.ts:70`.
- Memory tool is path-based CRUD: `src/tools/memory.ts`.
- No `RunFinish`/`PostTask` hook for reflection: `src/harness/hooks.ts`.

**Impact:** Large memory files silently truncate; the model cannot recall the right fact for the current prompt; Athena does not compound knowledge automatically.

**Recommendation:**
- Add a cheap keyword/Grep-based memory recall step before each turn (embeddings later).
- Add a `RunFinish` hook that prompts the model to write a concise feedback memory after corrected or completed tasks.
- Protect `LEARNED.md` from manual `Memory` tool writes and write memory files atomically.

---

### 9. Learning is CLI-driven scaffolding, not an automatic loop

The learning pipeline is structurally complete and tested, but the user must manually run `athena learn reflect`, `evaluate`, `promote`, `canary`, `finalize`, etc. There is no scheduler, no automatic candidate creation after failures, and no automatic consolidation after promotion.

- All learning commands are CLI subcommands: `src/cli.ts:942-1039`.
- `reflectTraces` is rule-based and always produces low-confidence memory candidates: `src/learning/candidates.ts:132`.
- Only `target: 'memory'` candidates are auto-generated; `skill`, `prompt`, `policy`, and `code` targets exist in the schema but are not produced.

**Impact:** "Governed recursive learning" is possible but not automatic; the user has to operate the machinery by hand.

**Recommendation:**
- Add an opt-in `autoReflect` setting that creates low-confidence memory candidates after failed or complex turns.
- Add a background/scheduled `athena learn consolidate` job (or a cron-friendly CLI path).
- Expand `reflectTraces` to optionally use an LLM for distillation and to emit non-memory candidate types.

---

## Medium-impact gaps (CLI / TUX)

### 10. `--max-tokens` in `athena exec` is misleading

`--max-tokens` sets the **total run token budget**, not the per-response output cap. There is no `--max-output-tokens` flag to override the per-response cap.

- `--max-tokens` mapped to `RunLimits.maxTokens`: `src/cli.ts:289-296`.
- `RunLimits.maxTokens` sums input + output + cache tokens: `src/engine/run.ts:51-58`.
- `maxOutputTokens` is a settings key but not an `exec` flag: `src/brain/settings.ts:197`.

**Recommendation:** Rename the budget flag to `--max-budget-tokens` (keeping `--max-tokens` as a deprecated alias), and add `--max-output-tokens` for the per-response cap.

---

### 11. Missing `--effort` flag for `athena exec`

Headless runs default to `high` effort and cannot tune reasoning depth from the command line.

- `EXEC_USAGE` does not list `--effort`: `src/cli.ts:174-179`.
- `parseExecArgs` has no `--effort` branch.

**Recommendation:** Add `--effort low|medium|high|xhigh|max` to `exec`.

---

### 12. `/model` picker breaks when invoked from the slash menu

Typing `/model` and pressing Enter opens the picker, but selecting "model" from the slash menu inserts `/model ` (with a trailing space) and fails the bare-command detection, showing a usage error instead.

- Exact-match detection: `src/tui/App.tsx:171-176`.
- Slash menu submits the spaced text: `src/tui/components/InputBox.tsx:251-269`.

**Recommendation:** Trim and ignore trailing whitespace in `detectBarePickableCommand`, or make the slash menu submit the bare command name without trailing space.

---

### 13. Assistant thinking blocks are not rendered in the TUI

The engine emits `assistant-thinking` events, but `reduceEvent` ignores them.

- Thinking events emitted: `src/engine/loop.ts:323`.
- No `case 'assistant-thinking'` in the TUI reducer: `src/tui/App.tsx:732-811`.

**Recommendation:** Render thinking blocks in an expandable section of the assistant message, or in a dedicated thinking panel.

---

### 14. Tool cards are always collapsed

`ToolCard` supports an `expanded` prop, but `Transcript.tsx` never expands it. Long tool outputs are unreadable in the TUI.

- ToolCard collapsed by default: `src/tui/components/Transcript.tsx:76-85`.

**Recommendation:** Add a keybinding (e.g., Enter or Space) to expand/collapse the focused tool card, and auto-expand cards with errors.

---

### 15. Missing `/cost`, `/sandbox`, `/checkpoint`, and `/undo` slash commands

- `/cost`: engine tracks it; no UI.
- `/sandbox`: switching modes requires editing `settings.json` and restarting.
- `/checkpoint` and `/undo`: checkpoints/rewind exist only through `athena session ...` CLI.

**Recommendation:** Add these slash commands and wire them to the existing session and settings machinery.

---

## Lower-impact / security and platform gaps

### 16. No Windows process sandbox

Documented and intentional: restricted shell calls fail closed on Windows. Linux uses `bwrap`, macOS uses `sandbox-exec`.

- Windows throw path: `src/tools/shell.ts:162-166`.
- README note: `README.md:83-86`.

**Recommendation:** Add a Windows sandbox adapter (e.g., AppContainer or a restricted token) when platform parity is needed.

---

### 17. Shell permission rules are advisory only

Prefix rules like `git:*` or `npm:*` can be bypassed with shell metacharacters, subshells, and absolute interpreter paths.

- Advisory nature documented: `src/harness/permissions.ts:97-107`.
- Prefix extraction uses the first whitespace token only: `src/engine/loop.ts:719-723`.

**Recommendation:** Keep prefix rules as a convenience, but communicate clearly that real isolation requires the OS sandbox. Consider requiring `plan` or `trusted` mode for shell tools that cannot be sandboxed.

---

### 18. Plugin signatures are optional by default

`requireSignature` must be passed explicitly (`athena plugin install --require-signature`). There is no key pinning or load-time verification.

- Optional signatures: `src/harness/plugins.ts:261-265`.

**Recommendation:**
- Add a global setting `plugins.requireSignature` defaulting to `false` for now.
- Verify plugin digests on every load.
- Allow key pinning in settings for trusted plugin authors.

---

### 19. MCP OAuth only supports client credentials

No authorization-code or device-code flow.

- Only `client_credentials` implemented: `src/brain/settings.ts:125-132`.

**Recommendation:** Add authorization-code/device-code flows when users need to connect to MCP servers that require user consent.

---

### 20. Settings schema silently strips unknown keys

Typos like `maxTokens` instead of `maxOutputTokens` are ignored rather than warned, which can mislead users.

- Plain `z.object({...})` without `.strict()` or `.passthrough()`: `src/brain/settings.ts`.

**Recommendation:** Add `.strict()` mode or emit warnings for unknown keys during settings load.

---

## Additional tool-level findings

| Finding | Location | Impact |
|---|---|---|
| `TaskOutput` is not auto-injected when an agent uses `tools: null` | `src/harness/agents.ts:158-168` | Sub-agents with all tools and background shell tasks cannot poll them |
| Notebook edit only supports editing a single existing cell; no create/delete | `src/tools/notebook.ts:12-23` | Full notebook workflows unsupported |
| No tool to create a notebook from scratch | N/A | Model cannot write `.ipynb` files |
| Diagnostics tool only supports TypeScript | `src/tools/diagnostics.ts:30-36` | Non-TS projects get no diagnostics tool |
| ReadImage hard-caps images at 5 MiB | `src/tools/image.ts:8` | Large screenshots/photos rejected |
| ApplyPatch cannot apply patches to files >10 MiB | `src/tools/apply-patch.ts:32` | Large files cannot be edited via patch |
| Grep treats exit code 1 as "no matches" | `src/tools/grep.ts:53` | ripgrep errors may be misreported |
| Shell stdout/stderr are merged; interleaving is lost | `src/tools/shell.ts:222-223` | Model cannot distinguish error source |
| Memory tool uses synchronous file I/O | `src/tools/memory.ts:2-9`, `src/tools/memory.ts:85-92` | Blocks event loop for large memory files |
| TodoWrite is marked `readOnly: true` despite mutating session state | `src/tools/todo.ts:17` | Permission engine treats it as unconditionally safe |

---

## Performance and efficiency notes

| Finding | Location | Impact |
|---|---|---|
| Tool schemas are re-converted from Zod every model call | `src/engine/loop.ts:130-136` | Wasted CPU per turn; should be cached per registry |
| Token estimator uses naive `chars / 3.2` heuristic | `src/engine/context.ts:100-103` | Can trigger premature compaction or miss real limits |
| Compaction uses the same expensive model as the main turn | `src/engine/loop.ts:489-510` | Could use a cheaper model for low-creativity summarization |
| Context usage is estimated, not measured before large calls | `src/engine/loop.ts:217-225` | Relies on prior response + heuristic |
| `RunBudget.maxTokens` double-counts cache tokens | `src/engine/run.ts:51-58` | Can cause premature limit hits |

---

## Recommended prioritization

If capacity is limited, tackle the gaps in this order:

1. **Prompt caching for tools and stable context blocks** — biggest cost/latency win.
2. **Surface cost/tokens in the TUI** — add `/cost` and update the status line.
3. **Parallelize read-only tool batches** — easy latency win for common patterns.
4. **Graduated compaction** — preserve more useful context in long sessions.
5. **Fix `/model` picker from slash menu** — small bug, large discoverability impact.
6. **Render thinking blocks and make ToolCards expandable** — makes the TUI feel finished.
7. **Add `--max-output-tokens` and `--effort` to `exec`** — headless parity.
8. **Auto-load relevant skills into context** — reduce friction for skill libraries.
9. **Relevance-based memory recall + reflection hook** — start compounding knowledge.
10. **Windows process sandbox** — platform parity, but a larger project.

---

## Appendix: gates run during this audit

```text
$ pnpm typecheck
> tsc --noEmit
(success)

$ pnpm lint
> eslint .
(success)

$ pnpm test
Test Files  76 passed (76)
     Tests  649 passed (649)
  Duration  11.97s
```
