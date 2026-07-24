# Athena Harness Parity Evaluation

**Date:** 2026-07-24

**Scope:** Athena at commit `6f5864c` before this report

**Target:** Observable capability and behavioral parity with current Claude Code and Codex CLI, while preserving Athena's intentional extensions and developing safe recursive self-improvement

## Executive verdict

Athena is a credible first-generation interactive coding-agent harness. Its central model/tool loop is coherent, the code is cleanly separated into Brain, Engine, Harness, and TUI layers, the terminal experience is already substantial, and the deterministic suite is healthy: **574 of 574 tests pass across 179 suites**, with typecheck and lint also clean.

It is **not yet a drop-in equivalent** to Claude Code or Codex CLI. On a strict, behavior-weighted parity rubric, Athena scores **43/100**. That is not a percentage of code written; it is a measure of observable equivalence. The interactive kernel is much closer than 43%, but the missing portions are disproportionately important: project trust, enforceable containment, non-interactive automation, model-aware context control, mature session/subagent lifecycles, and full extension semantics.

The most important conclusion is that Athena should not currently be opened in an untrusted repository. A project `.athena/settings.json` can activate hooks and MCP commands before a trust decision, and it can select `trusted` permission mode. The permission layer is a model-facing approval policy, not an operating-system sandbox. That combination creates a direct repository-to-host execution path.

Recursive self-improvement is presently **scaffolding, not a closed learning loop**. Athena can persist memories and load skills, agents, hooks, and a constitution, but it does not yet measure task outcomes, derive candidate changes, evaluate them on held-out cases, promote them through a reversible gate, or prove that a later run improved. The correct next move is to build the evaluation and evidence substrate before granting the runtime broader self-modification authority.

## Method and limitations

This review:

- traced the CLI bootstrap, engine loop, context management, permissions, built-in tools, sessions, hooks, MCP, plugins, skills, agents, credentials, and TUI;
- reviewed the test inventory and ran all local quality gates available before report creation;
- compared observable behavior with current official Claude Code and Codex documentation;
- assessed recursive improvement against an evidence-driven loop: observe, infer, encode, reuse, test, refine, and curate.

The assessment is platform-specific. Athena is primarily a **TypeScript/Node interactive CLI/TUI** and secondarily an **AI-agent orchestration runtime** with external model providers and MCP subprocesses. Findings therefore emphasize CLI exit behavior, terminal and process lifecycle, filesystem and network containment, secret handling, model failure modes, bounded resource use, and evaluation quality.

This was a static and deterministic local assessment. It did not make paid live-model calls, exercise a remote MCP/OAuth service, conduct a full adversarial security test, or benchmark interactive terminal rendering. Publicly documented behavior can be compared; proprietary implementation details cannot.

## Scorecard

| Dimension | Weight | Score | Assessment |
|---|---:|---:|---|
| Core model/tool loop | 15 | 12 | Strong tool-result invariants, cancellation, retries, and provider abstraction; no loop budget or complete usage accounting |
| Built-in tool plane | 12 | 7 | Useful editing/search/shell/web/memory base; missing richer standard tools and several resource bounds |
| Security, trust, and containment | 15 | 2 | Permission prompts exist, but project trust and enforceable sandbox boundaries do not |
| Context and sessions | 10 | 5 | Persistence and compaction work at a basic level; budgets, recovery, and resumed UX are incomplete |
| Subagents and concurrency | 10 | 4 | Functional one-level child agents; lifecycle, visibility, isolation, limits, and resumption are shallow |
| Skills, hooks, MCP, and plugins | 12 | 5 | All four concepts exist; their contracts are materially narrower than the reference CLIs |
| Automation and composability | 10 | 2 | Interactive-only; no headless/JSONL/stdin/output-schema contract |
| Operator/TUI experience | 6 | 4.5 | Polished full-screen interaction and approvals; limited history, streaming, cost, and child-agent visibility |
| Observability and evaluations | 5 | 1 | Good unit suite, but no production CI, outcome evals, golden traces, cost ledger, or live canary |
| Recursive self-improvement | 5 | 0.5 | Persistence primitives exist; no measured, gated, reversible improvement cycle |
| **Total** | **100** | **43** | **Capable v1 harness, not parity** |

As a secondary estimate, the core interactive kernel is roughly **70–75%** of a mature coding-agent kernel, while safe recursive self-improvement is roughly **10%** of the required system. These estimates are intentionally separate: averaging them would hide the highest-risk gaps.

## Observable capability comparison

| Capability | Athena now | Claude Code / Codex reference behavior | Parity |
|---|---|---|---|
| Interactive TUI | Full-screen and classic Ink interfaces, slash and mention pickers, approvals | Mature interactive terminal clients | Close at the basic interaction layer |
| Non-interactive execution | Non-TTY input prints help and exits | Prompt/stdin execution, text or JSON/JSONL streaming, explicit exit behavior, schemas and limits | Missing |
| Model/tool loop | Streaming, tool calls, dangling-result repair, cancellation | Bounded, observable agent execution with richer automation controls | Partial |
| Editing/search/shell | Read, Write, Edit, Glob, Grep, Bash, background Bash | Comparable core plus patch-oriented edits, richer media/notebook/browser surfaces depending on harness | Partial |
| Permission UX | Normal, accept-edits, plan, trusted; allow/deny patterns | Permissions integrated with project trust and sandbox policy | Superficially similar, semantically weaker |
| OS containment | None beyond child-process management and advisory checks | Codex exposes read-only/workspace-write/danger sandbox modes; both products establish repo trust boundaries | Missing |
| Project trust | Project config and extensions load automatically | Project-local configuration and MCP are gated by trust/approval | Missing |
| Sessions | JSONL save/list/load/resume/continue | Resume/follow-up plus richer checkpoint/rewind or automation semantics | Partial |
| Context management | Fixed 200k budget, whole-summary compaction, six-message tail | Model-aware budgets and more mature long-context management | Partial |
| Subagents | One nested level, parallel when all calls are agents, result-only return | Permissions, skills, MCP, hooks, effort, memory, backgrounding, isolation, resumption, limits | Partial |
| Skills | Loads `SKILL.md` bodies on demand | Progressive discovery with paths, budgets, support files, scripts, references, and assets | Partial |
| Hooks | Five sequential command events | Broad lifecycle, multiple hook types, parallelism, structured decisions and context | Partial |
| MCP | stdio tools | stdio and streamable HTTP, OAuth, approval, management, richer protocol surfaces | Partial |
| Plugins | Global drop-in skill/agent/command folders | Managed install/update/enable/disable and richer bundled capabilities | Early |
| Auth/provider deployment | API-key files for Anthropic and Kimi variants | Subscription/console OAuth and enterprise deployments in Claude; richer provider/account flows in Codex | Partial by intentional scope |
| Checkpoint/rewind | None | Claude Code automatically checkpoints and can rewind code/conversation | Missing |
| Evals/observability | Unit tests and sparse journal events | Mature products expose richer diagnostics; equivalence needs independent outcome/cost/safety evals | Missing |

The relevant public contracts are documented in the [Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage), [Claude Code subagent documentation](https://code.claude.com/docs/en/sub-agents), [Claude Code checkpointing documentation](https://code.claude.com/docs/en/checkpointing), [Codex CLI reference](https://developers.openai.com/codex/cli/reference/), and [Codex configuration reference](https://developers.openai.com/codex/config-reference/).

## Findings

### P0 — Untrusted project configuration can execute host commands at startup

**Evidence:** `src/brain/settings.ts:84-101`, `src/cli.ts:463-499`, `src/cli.ts:604`, `src/harness/mcp.ts:103-140`

Project settings are merged automatically. Those settings may:

- select `permissionMode: "trusted"`;
- define command hooks, including `SessionStart`;
- define MCP stdio servers that are connected and spawned before the interactive session begins;
- add allow rules for mutating tools.

There is no canonical-path trust registry or first-open confirmation. Hooks and MCP startup are not themselves mediated by the tool permission gate. Opening a cloned repository is therefore enough to cross from repository-controlled configuration into local command execution.

This is a parity and release blocker, not a cosmetic permission difference. Current Codex configuration explicitly distinguishes trusted and untrusted projects, and Claude Code applies project MCP approval. See [Codex project trust](https://developers.openai.com/codex/config-reference/) and [Claude Code MCP security](https://code.claude.com/docs/en/mcp).

**Recommendation:** Introduce a canonical project identity and trust database outside the repository. Until trusted, ignore project hooks, MCP, agents, skills, commands, permission-mode escalation, and any project policy that weakens global policy. Show the exact executable, arguments, working directory, environment names, and source file before separate MCP/hook approval. A project must never be able to select `trusted` mode for itself.

**Risk if unfixed:** Repository-supplied arbitrary command execution under the user's account.

### P0 — Permission policy is not a sandbox, and important filesystem/network boundaries are bypassable

**Evidence:** `src/harness/permissions.ts:49-50`, `src/harness/permissions.ts:85-108`, `src/harness/permissions.ts:141-167`, `src/tools/webfetch.ts:9-12`, `src/tools/webfetch.ts:68-80`

The gate controls whether Athena asks before invoking a tool. It does not constrain the resulting process with OS filesystem, process, or network controls. Read-only tools are automatically allowed in normal mode. Path canonicalization uses lexical `resolve`, not `realpath`, so symlinks can escape path rules. `Glob` and `Grep` use a `path` argument while permission target matching only canonicalizes `file_path`, weakening path-scoped policy consistency.

`WebFetch` blocks two literal metadata hosts, but not loopback, RFC1918, IPv6 local/private ranges, DNS rebinding, or redirects to forbidden destinations. Redirects are followed without validating every hop. A prompt-injected model can therefore probe local services or return private data to the model provider.

**Recommendation:** Add a brokered execution layer with explicit `read-only`, `workspace-write`, and deliberately dangerous unrestricted modes. Resolve and verify real paths at the moment of use; reject symlink escapes and recheck after parent creation. Apply the same normalized resource model to every path-bearing tool. For network calls, resolve DNS, block local/private/link-local ranges by default, validate each redirect, cap response bytes while streaming, and support a domain allowlist. MCP subprocesses should receive an environment allowlist, not the complete inherited environment.

**Risk if unfixed:** Local data exposure, writes outside intended scope, and host/network access that the approval UI implies is contained but is not.

### P1 — Athena has no non-interactive agent contract

**Evidence:** `src/cli.ts:70-132`, `src/cli.ts:401-414`

Athena has no equivalent of `claude -p` or `codex exec`. It cannot accept a prompt over stdin, emit stable text/JSON/JSONL events, enforce `--max-turns` or a budget, validate an output schema, run ephemerally, or expose dependable exit codes for agent outcomes. In a non-TTY environment it prints help and exits.

This prevents CI use, shell composition, agent-to-agent orchestration, reproducible evaluations, and serious parity testing. The behavior is documented for [Claude Code CLI automation](https://docs.anthropic.com/en/docs/claude-code/cli-usage) and [Codex non-interactive execution](https://developers.openai.com/codex/cli/reference/).

**Recommendation:** Add an `athena exec` surface before expanding autonomous behavior. At minimum: prompt argument or stdin, `--output text|json|jsonl`, stable event schema, session/no-session choice, resume by ID, output schema, `--max-turns`, `--max-tool-calls`, token/cost/time budgets, permission/sandbox selection, and stable exit codes. Use the same Engine as the TUI.

**Risk if unfixed:** Athena cannot be evaluated or automated in the same way as the target CLIs.

### P1 — Model context and usage accounting are fixed, late, and incomplete

**Evidence:** `src/cli.ts:566-587`, `src/engine/loop.ts:153-216`, `src/engine/loop.ts:296-323`, `src/engine/client.ts:64-111`, `src/brain/models.ts:93-98`

All providers receive a fixed 200k context window and 8,192 output tokens despite model entries with different advertised limits. Context pressure is checked after a tool cycle, not before the first request. The complete system prompt, tool schema set, project instructions, constitution, memory index, and agent definitions are resent without prompt-caching controls. Only the last response's usage is surfaced as the turn total, so multi-step turns undercount tokens and cannot support reliable cost budgets.

The client retries status-bearing overload/server errors, but ordinary network exceptions with no status are not retried, and the non-streaming completion path lacks the same retry/abort policy. Whole-summary compaction can also discard important tool-state detail without a checkpoint.

**Recommendation:** Put context window, max output, input pricing, output pricing, and feature support in the model registry. Estimate the complete next request before every call. Accumulate usage across all cycles, including cached tokens where available. Add model-specific prompt caching, bounded tool-output pruning, graduated compaction, compaction provenance, and a hard turn budget.

**Risk if unfixed:** Unexpected context failures, silent information loss, uncontrolled cost, and inaccurate operator telemetry.

### P1 — The agent loop and child-agent fan-out have no resource budget

**Evidence:** `src/engine/loop.ts:155`, `src/engine/loop.ts:228-251`, `src/harness/agents.ts:60-102`

The parent runs `for (;;)`. When every tool call is an `Agent` call, all are launched with `Promise.all`, with no concurrency ceiling. Child agents have no max-turn, token, cost, wall-clock, or tool-call budget and use fixed context settings. They cannot be paused, resumed, messaged, followed up, or inspected in real time. They have no worktree isolation, persistent memory, independent MCP/skills/hooks configuration, or background lifecycle.

One-level nesting is a sensible safety limit for a v1, but it is not equivalent to current documented subagent behavior. See [Claude Code subagents](https://code.claude.com/docs/en/sub-agents).

**Recommendation:** Define a first-class run record and scheduler. Every parent and child gets explicit limits, cancellation ancestry, concurrency admission, cumulative usage, event streaming, and terminal status. Add follow-up/resume only after persistence is durable; add worktree isolation before allowing concurrent mutating agents. Keep nesting disabled by default even when the architecture supports it.

**Risk if unfixed:** Runaway spend/latency, invisible failures, concurrent edit conflicts, and unreproducible agent behavior.

### P1 — Session persistence is basic and resumed context is invisible in the TUI

**Evidence:** `src/harness/sessions.ts:6-11`, `src/harness/sessions.ts:119-174`, `src/cli.ts:528-602`, `src/tui/App.tsx:224`

Sessions are grouped by replacing path separators with hyphens. Different paths can collide, and path identity is not canonicalized or hashed. Files are plaintext JSONL without locking, so concurrent writers can corrupt or overwrite state. Rewrites preserve messages but not a complete immutable event history.

On resume, historical messages are loaded into the Engine, but `App` initializes its visible entry list as empty and receives no historical transcript. The model sees the previous conversation while the user does not. `/resume` only tells the user to restart with a flag. There is no checkpoint, rewind, fork, rename, search, or deletion lifecycle.

Claude Code's observable checkpoint behavior is described in [checkpointing](https://code.claude.com/docs/en/checkpointing).

**Recommendation:** Use a canonical-path hash plus readable slug, an immutable append-only event log, transactional checkpoints, per-session locking, and schema versioning. Reconstruct both engine and TUI state from the same log. Add resume/fork/rewind semantics and redact or encrypt secrets/tool outputs according to a documented retention policy.

**Risk if unfixed:** Confusing resumed behavior, cross-project collisions, lost state, and sensitive transcript persistence without adequate controls.

### P1 — Extension concepts exist, but their execution contracts are substantially incomplete

**Evidence:** `src/brain/loader.ts:24-132`, `src/harness/hooks.ts:55-112`, `src/harness/mcp.ts:20-140`, `src/brain/plugins.ts:9-100`

**Skills:** Athena strips frontmatter and returns a skill body, but it does not reliably expose the skill directory. Relative scripts, references, assets, and nested resources therefore cannot be resolved with the semantics expected by mature skill systems. Discovery is one directory deep, initial metadata has no path/context budget, and trigger enforcement is left entirely to the model. Compare [Claude Code skills](https://code.claude.com/docs/en/skills) and [Codex skills](https://developers.openai.com/codex/skills/).

**Hooks:** Only five command events exist. Hooks run sequentially, use shell execution, have unbounded captured output, and kill only the direct child on timeout. A non-wildcard matcher can match events that have no `toolName`. Pre/Post added context and Stop results are not comprehensively applied. There are no HTTP, MCP-tool, prompt, or agent hook types; no parallel merge contract; and no broad lifecycle. Compare [Claude Code hooks](https://code.claude.com/docs/en/hooks-guide).

**MCP:** Only stdio tools are supported. The complete parent environment is inherited, all MCP tools are labeled mutating regardless of annotations, and image/resource content is reduced to placeholders. There is no streamable HTTP, OAuth, resources/prompts, elicitation, management CLI, capability negotiation, lazy tool search, or response byte cap. Compare [Claude Code MCP](https://code.claude.com/docs/en/mcp) and [Codex MCP](https://developers.openai.com/codex/mcp/).

**Plugins:** Plugins are global folder conventions for namespaced skills, agents, and commands. There is no manifest lifecycle, dependency/version handling, installation/removal/update, enablement state, provenance/signature policy, bundled MCP/hooks/apps, or marketplace.

**Recommendation:** Define versioned internal interfaces for every extension type before adding breadth. Preserve source path and provenance, impose input/output/time limits, validate schemas at load time, and make project trust part of every load decision. Compatibility tests should exercise supporting files, hook decision precedence, MCP transport/auth/content types, and plugin upgrades.

**Risk if unfixed:** Extensions appear compatible in simple demos but fail or become unsafe under real third-party content.

### P1 — Several tools can consume unbounded memory or block the event loop

**Evidence:** `src/tools/read.ts:20-32`, `src/tools/glob.ts:19-32`, `src/tools/grep.ts:27-46`, `src/harness/mcp.ts:71-89`, `src/tools/websearch.ts:20-53`

`Read` synchronously loads the complete file before slicing. `Glob` collects and stats the complete result set. `Grep` accumulates complete stdout before truncating. MCP text and WebSearch response bodies are unbounded. `Write` and `Edit` perform synchronous, non-atomic replacement.

Shell output is capped at its source and Windows process-tree termination is thoughtfully handled, but live output is not streamed to the TUI. Background jobs are held in a process-global map without per-session ownership, concurrency limits, or guaranteed cleanup on every exit path.

**Recommendation:** Use streaming reads and hard byte/result limits at the producer, not after buffering. Move blocking filesystem work off the main event loop. Make writes atomic with temp-file replacement and precondition hashes. Give background tasks ownership, admission limits, output ring buffers, process-group termination, and shutdown cleanup.

**Risk if unfixed:** A large repository, hostile MCP server, or unexpected web response can freeze or exhaust the CLI.

### P1 — There is no outcome evaluation system

**Evidence:** `tests/`, absence of a CI workflow, `src/engine/events.ts`, `src/cli.ts:590-604`

The deterministic suite is a real strength, but it primarily validates units and components. There is no checked-in binary end-to-end suite, cross-platform CI matrix, live-provider canary, golden event trace, adversarial prompt/tool test pack, property/fuzz suite, performance/load budget, or task-level outcome benchmark. The journal records only a narrow slice of engine activity and is not a sufficient trace for replay or learning.

**Recommendation:** Treat `athena exec` and a versioned event schema as prerequisites for evals. Create four layers:

1. deterministic protocol and security invariants;
2. golden end-to-end fixture tasks with a fake provider;
3. small live-provider canaries with fixed budgets and statistical scoring;
4. held-out coding tasks measuring success, safety violations, cost, latency, tool count, and regressions.

Run layers 1–2 on every pull request and layers 3–4 on controlled schedules or release candidates.

**Risk if unfixed:** Feature count can grow while actual task success, safety, or cost silently regress.

### P2 — Bootstrap/import ordering breaks the documented fresh import flow

**Evidence:** `src/cli.ts:358-362`, `src/brain/import.ts:72-76`

The CLI creates `memory/MEMORY.md` before parsing and running `import`. Import then rejects any non-empty target memory unless `--force` is supplied. A fresh normal installation therefore cannot perform the documented one-time import without `--force`, and existing unit tests do not combine bootstrap and import.

**Recommendation:** Parse side-effect-free commands first. Run import before scaffolding, or let import distinguish the untouched scaffold from user data. Add a process-level integration test with an isolated home directory.

**Risk if unfixed:** A core migration flow fails by construction and encourages unnecessary forced overwrite.

### P2 — CLI startup and crash behavior have avoidable side effects

**Evidence:** `src/cli.ts:358-414`, `src/cli.ts:606-619`, `src/tui/fullscreen.ts:53-60`

`ensureBrainScaffold` runs before `--help`, `--version`, and import parsing, so informational commands mutate the user's home directory. The uncaught-exception handler logs but explicitly keeps the process alive even though Node state may be inconsistent. Full-screen signal handling calls `process.exit`, which can bypass normal MCP cleanup.

**Recommendation:** Parse help/version and other side-effect-free commands before bootstrap. On uncaught exceptions, write a bounded crash record, attempt a short idempotent cleanup, and exit non-zero. Route signal handling through the same cancellation and cleanup coordinator.

**Risk if unfixed:** Surprising filesystem mutations, orphaned children, and continued execution after undefined process state.

### P2 — Authentication and secret storage do not yet match mature CLI deployment options

**Evidence:** `src/brain/credentials.ts:18-99`, `src/cli.ts:323-354`

Credential files are atomically written and use restrictive POSIX permissions, which is good. They remain plaintext, Windows permission hardening is not equivalent to a keychain, and only API-key authentication is implemented. There is no OS credential vault, subscription/console OAuth, enterprise Bedrock/Vertex path, credential broker, or automated secret rotation.

Some narrower provider scope may be intentional, but it must be documented as a deliberate non-parity decision. Claude Code's public options are summarized in [getting started and authentication](https://docs.anthropic.com/en/docs/claude-code/getting-started).

**Recommendation:** Use the OS credential store where available, retain environment-variable injection for ephemeral automation, and define provider adapters around explicit auth capabilities. Never forward all secrets to project-defined subprocesses.

**Risk if unfixed:** Weaker local secret protection and a narrower enterprise/deployment envelope.

## What Athena already does well

These are foundations worth preserving:

- The Brain/Engine/Harness/TUI separation gives policy, orchestration, side effects, and presentation sensible seams.
- The Engine repairs dangling tool-use state and preserves tool-result ordering, avoiding common provider protocol failures.
- Provider/model abstraction and thinking-effort gating are explicit rather than scattered across the UI.
- Cancellation propagates through the parent/child agent path and into several long-running tools.
- Shell output has a source cap, and Windows process-tree termination is handled more carefully than in many early agent CLIs.
- Session rewrites and credential writes use atomic replacement.
- Edit validates `old_string` and requires uniqueness by default, reducing accidental broad edits.
- The TUI has a usable permission queue, busy-state handling, picker interactions, and separate classic/full-screen modes.
- The test suite is broad at the unit/component level and currently clean.

## Recursive self-improvement assessment

Athena currently provides three ingredients:

1. durable text artifacts: constitution, memory index/items, skills, agents, commands, and settings;
2. prompt-time recall of the memory index and discoverable extensions;
3. tools that let an agent change files and manually create memory items.

Those ingredients enable **manual adaptation**. They do not establish recursive improvement. A defensible improvement loop requires all of the following:

```text
immutable run trace
        ↓
task/safety/cost evaluator
        ↓
candidate lesson or code/prompt/skill change
        ↓
isolated experiment against training + held-out cases
        ↓
promotion gate with human policy
        ↓
versioned canary deployment
        ↓
measured next-run delta and rollback
```

### Missing learning primitives

- a stable task/run identity and complete event/evidence ledger;
- task success labels and evaluator calibration;
- baseline-versus-candidate comparison;
- held-out cases that prevent optimizing only the examples that produced the lesson;
- provenance, confidence, scope, expiry, and contradiction handling for memories;
- memory consolidation, deduplication, decay, and deletion;
- skill synthesis with compatibility/security validation;
- isolated branches/worktrees or another candidate-change sandbox;
- promotion policies and a human approval boundary;
- canarying, rollback, and version lineage;
- a monotonicity rule covering safety, cost, latency, and previously passing tasks.

### Recommended learning contract

A learning candidate should be a typed artifact, not an unrestricted self-edit:

```ts
interface LearningCandidate {
  sourceRunIds: string[]
  hypothesis: string
  target: 'memory' | 'skill' | 'prompt' | 'policy' | 'code'
  patch: string
  expectedMetricDelta: Record<string, number>
  applicability: string[]
  counterexamples: string[]
  confidence: number
  expiresAt?: string
}
```

Promotion should require:

- deterministic safety and protocol invariants remain green;
- previously passing held-out cases remain green;
- the target metric improves beyond a configured uncertainty threshold;
- cost and latency stay inside budgets;
- provenance and generated diffs are inspectable;
- code, policy, hook, MCP, or permission changes receive human approval;
- rollback is a single versioned operation.

The ratchet should be conservative: **no candidate is promoted unless its lower-confidence-bound outcome improves and no safety invariant regresses**. A single successful run may create a provisional hypothesis, not a trusted procedure.

### Suggested maturity levels

| Level | Definition | Athena now |
|---|---|---|
| L0 — Static | Fixed prompt and tools | Passed |
| L1 — Persistent | Durable user-authored memory/skills | Partially passed |
| L2 — Reflective | Automatically derives typed lessons with provenance | Not present |
| L3 — Evaluated | Replays candidates against baseline and held-out suites | Not present |
| L4 — Governed | Approval, canary, versioning, rollback, audit trail | Not present |
| L5 — Recursive | Repeated measured gains without safety regression | Not present |

Athena is approximately **L1**. Reaching L3 safely is more valuable than adding an unconstrained “edit yourself” loop.

## Recommended delivery sequence

### Phase 0 — Establish a safe trust boundary

Release criterion: an untrusted repository cannot cause command execution, weaken policy, read outside allowed roots, or reach local/private network services without a clear user decision.

- project trust registry and safe untrusted load mode;
- separate approval for project MCP and command hooks;
- OS-backed filesystem/process/network sandbox modes;
- realpath/symlink-safe resource authorization;
- MCP environment allowlist and protocol/output limits;
- SSRF-safe web broker;
- bounded I/O, atomic edits, and coordinated process cleanup;
- red-team fixtures for malicious `.athena`, MCP, hooks, symlinks, redirects, and prompt injection.

### Phase 1 — Make the harness automatable and measurable

Release criterion: a task can be reproduced from a command, produces a versioned trace, and terminates inside explicit budgets.

- `athena exec`, stdin, text/JSON/JSONL, output schema, stable exit codes;
- max turns/tool calls/concurrency/time/tokens/cost;
- cumulative usage and provider price accounting;
- model-specific context/output capabilities and preflight budgeting;
- immutable event schema with complete parent/child/tool lifecycle;
- fake-provider binary end-to-end tests and production CI.

### Phase 2 — Close standard harness semantics

Release criterion: core documented workflows have behavioral compatibility tests.

- visible, collision-safe resume/fork/checkpoint/rewind;
- live shell and child-agent event streaming;
- resumable/follow-up child agents with isolation and limits;
- progressive skill resources and path semantics;
- structured, bounded lifecycle hooks;
- managed MCP with stdio/HTTP/OAuth and explicit trust;
- versioned plugin manifests and lifecycle;
- richer patch/media/browser/notebook/LSP tools where they are part of the chosen parity target;
- OS credential-store integration and diagnostics/updater story.

### Phase 3 — Introduce governed learning

Release criterion: a candidate improvement beats a stored baseline on held-out tasks and can be reverted.

- trace warehouse and evaluator registry;
- memory provenance/consolidation;
- reflection-to-candidate generation;
- isolated candidate worktree and deterministic gates;
- held-out task, safety, cost, and latency evaluation;
- human promotion policy, signed version lineage, canary, and rollback;
- repeated-run measurement proving a real delta.

## Definition of parity

“Same capabilities” should become a checked contract, not a subjective milestone. A release can claim standard-harness parity only when:

- every selected public CLI workflow has an Athena compatibility scenario;
- trust, sandbox, permissions, and extension precedence are tested as behavior, not inferred from names;
- interactive and non-interactive paths use the same engine and yield compatible traces;
- failures have stable exit/status semantics;
- all loops and outputs are bounded;
- sessions and child agents can be reconstructed from durable state;
- the supported platform matrix passes in CI;
- live canaries meet success, safety, cost, and latency thresholds;
- deliberate non-parity decisions are explicitly listed.

The extra recursive layer should have its own claim: Athena may call itself self-improving only after a later run demonstrates a measured gain against a prior baseline, with regression checks and rollback. Persisting a lesson alone is learning storage; it is not proof of improvement.

## Verification snapshot

On the working tree containing this report:

- `npm.cmd run build` — passed
- `npm.cmd run typecheck` — passed
- `npm.cmd run lint` — passed
- Vitest — **179/179 suites passed, 574/574 tests passed**
- current CI workflow — none found

## Reference baseline

Official public documentation used for behavioral comparison:

- [Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage)
- [Claude Code subagents](https://code.claude.com/docs/en/sub-agents)
- [Claude Code checkpointing](https://code.claude.com/docs/en/checkpointing)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks-guide)
- [Claude Code MCP](https://code.claude.com/docs/en/mcp)
- [Claude Code skills](https://code.claude.com/docs/en/skills)
- [Claude Code getting started and authentication](https://docs.anthropic.com/en/docs/claude-code/getting-started)
- [Codex CLI overview](https://developers.openai.com/codex/cli/)
- [Codex CLI reference](https://developers.openai.com/codex/cli/reference/)
- [Codex configuration and project trust](https://developers.openai.com/codex/config-reference/)
- [Codex MCP](https://developers.openai.com/codex/mcp/)
- [Codex skills](https://developers.openai.com/codex/skills/)
