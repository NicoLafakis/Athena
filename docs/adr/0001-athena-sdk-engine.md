# ADR 0001 — Athena: Claude Agent SDK engine, live Ares brain

- **Status:** Accepted
- **Date:** 2026-07-21
- **Deciders:** Nico (principal), Ares (orchestration)
- **Supersedes:** the standalone Electron chatbot at repo root (`main.js`, `src/`), which becomes a tool/embodiment source, not the product core.

## Context

We want our own coding tool — a Claude Code equivalent tuned to how we build — that:

1. Runs as **both** a terminal CLI and a VS Code extension.
2. Is **multi-provider**: Anthropic Claude, OpenAI, Moonshot Kimi, MiniMax.
3. Ships with our agents and skills native, and our recursive-self-improvement (RSI) loop, memory, and recall as first-class behavior.

We already own the three layers this requires, currently scattered:

- **Engine** — the existing Athena Electron app runs its own tool-use loop against `@anthropic-ai/sdk` with custom tools (`filesystem`, `terminal`, `screen`, `input`, `apps`).
- **Brain** — the Ares harness (`~/.claude`): ~54 agents, 59 skills, 14 lifecycle hooks, a markdown memory store with a `MEMORY.md` index and `[[wikilinks]]`, `intentions.jsonl` prospective memory, a journal, and three self-improvement loops.
- **Continuity** — the RSI loops, memory consolidation/exploration, and fixture-gated ratchet inside Ares.

Four research streams (multi-provider integration, OSS-engine landscape, Claude Agent SDK feasibility, and a portability audit of our own assets) converged on a single conclusion, recorded below.

## Decision

Build **Athena** as a **TypeScript application on the Claude Agent SDK**, riding the **live Ares harness in place** as its brain, targeting **Windows only**, shipping as a **terminal CLI and a VS Code extension** off one shared core.

Sub-decisions:

1. **Engine: Claude Agent SDK (TypeScript).** The SDK provides the agent loop, tool execution, permissions, subagents, sessions, context compaction, hooks, and MCP — and it natively loads `.claude/` config (CLAUDE.md, `skills/`, `agents/`, `settings.json` hooks). Our entire brain is already authored in that format, so it maps in with light shims rather than a rewrite. TypeScript over Python for single-binary distribution and to keep the stack unified with the existing Node/Electron code.

2. **Brain: live Ares, in place (personal-first).** Athena points its config loader at the real `~/.claude`/Ares directory. Nico's identity, memories, RSI, and corrections are the source of truth and travel because Athena reads them, not a copy. A distributable build with a bundled empty-memory brain is a **later fork**, out of scope here.

3. **Providers: Anthropic Messages shape as the internal contract.** Claude, Kimi, and MiniMax all speak the Anthropic Messages API natively — they are `base_url` + auth swaps behind a per-provider **capability descriptor** (see below). **OpenAI** is the only shape mismatch and is bridged by **LiteLLM scoped to OpenAI only**, pinned to a known-clean version and run as a **bundled local sidecar** (never a network dependency). OpenAI sits behind the same `Provider` interface, so a hand-rolled thin translator can replace LiteLLM later with zero upstream churn.

4. **Platform: Windows only.** Keeps the Ares `py` scripts and Windows Task Scheduler (the RSI reflection job) native, and narrows distribution to one target. Adapters are still written platform-neutrally so the CLI/extension aren't structurally boxed in.

## Architecture

```
Surfaces:   Terminal CLI (repurposed Athena shell)  |  VS Code extension
                         \___________  ___________/
                                     \/
Core:       Claude Agent SDK (TS) — loop, tools, permissions,
            subagents, sessions, hooks, MCP, context compaction
Providers:  internal contract = Anthropic Messages
            + per-provider capability descriptor
            Claude / Kimi / MiniMax → direct (base_url + auth)
            OpenAI → LiteLLM sidecar (pinned, local, OpenAI-scoped)
Brain:      live Ares config (CLAUDE.md, agents, skills, memory +
            MEMORY.md, intentions.jsonl, journal, harness-fixtures)
Tools:      SDK built-ins + Athena's screen/input/apps as custom/MCP tools
```

### Provider capability descriptor

Compatibility across the three "Anthropic-compatible" providers is a *dialect*, not identity. Each provider is described by a capability record instead of hardcoded assumptions:

```
{ auth_header, base_url, context_window, temperature_range,
  requires_thinking, supports_thinking_blocks,
  supports_cache_control, supports_web_tools }
```

Known dialect facts to encode (verified July 2026, treat model IDs as volatile — read `/models` at runtime):

- **Kimi (Moonshot):** `https://api.moonshot.ai/anthropic`, auth `ANTHROPIC_AUTH_TOKEN`. `kimi-k2.7-code` **requires** thinking enabled (400s otherwise); `kimi-k3` thinks by default. Anthropic-compat endpoint does **not** support web tools — set `ENABLE_TOOL_SEARCH=false`. Must announce context via `CLAUDE_CODE_AUTO_COMPACT_WINDOW`.
- **MiniMax:** `https://api.minimax.io/anthropic`, auth `ANTHROPIC_API_KEY`. `MiniMax-M2.x` support text + tool-call blocks only (no thinking blocks); `MiniMax-M3` adds thinking. Ignores `top_k`, `stop_sequences`, `mcp_servers`; temperature range `[0, 2]`.
- **Anthropic:** native; manual prompt caching via `cache_control` breakpoints.
- **OpenAI:** via LiteLLM sidecar; `cache_control` markers are meaningless downstream and must be stripped; tool-call and streaming shapes translated by the sidecar.

### The four adapter seams (the only Claude-Code-coupled work)

Everything else is native SDK config or self-contained Python CLI tools. The seams to engineer:

1. **Transcript access + shape.** Ares reads `~/.claude/projects/*.jsonl`. Abstract behind a `getSessions()` adapter so the RSI loops and capture hook don't depend on the log format.
2. **Hook event/return contract.** The `additionalContext` injection and the `Stop → decision:block` re-prompt (which drives the recursive-learning nudge). Verify SDK equivalents and build the hook host around them.
3. **Native memory injections.** The `# auto memory` write/read protocol and the "this memory is N days old, verify" freshness reminder are Claude Code built-ins. Reimplement as SessionStart + read-time hooks.
4. **Headless sub-model call + scheduler.** RSI Loop A (reflection) shells out to `claude -p` on a 4×/day Windows Task Scheduler job. Swap the sub-call for an SDK `query()` call; keep Task Scheduler on Windows.

### Portability summary

- **Ports native (light shim):** CLAUDE.md rules + identity, all skills (incl. recursive-learning), agents + routing index (regenerated as a build step), the memory store + `MEMORY.md` + wikilinks + recall (recall is model-driven, no machinery), `intentions.jsonl`, journal, fixtures, RSI Loop B.
- **Must re-host / build:** the 14 Python hooks (TS ports or `command` shims — the pure-injection ones are easy, the deny-gates need careful porting), the four seams, the provider layer + OpenAI sidecar, RSI Loop A (reflection) and Loop C (prompt-evolution telemetry), the VS Code extension host, the CLI shell, and Windows distribution.

## Consequences

**Positive**

- Our brain drops in instead of being rewritten; a fork would have forced re-authoring every hook, the settings schema, and the RSI onto a foreign lifecycle.
- Multi-provider is nearly free: 3 of 4 providers are native to the SDK; only OpenAI needs the (already-maintained) bridge.
- No fork-drift tax — we build on a maintained library, not a diverging fork.
- Personal-first + Windows-only removes cross-platform and bundled-brain complexity from v1.

**Negative / risks**

- The SDK is Anthropic-first; OpenAI remains a second-class path (true for any option — OpenAI is the outlier everywhere).
- LiteLLM shipped credential-stealing malware in 1.82.7 / 1.82.8 — **pin and vendor a known-clean version, never auto-update.**
- Provider model IDs move weekly (Kimi K3, MiniMax M3 current) — read `/models` at runtime rather than hardcoding.
- Memory write-side has no curator/validator today (honor-system dedup) — a known rough edge carried over from Ares, to harden later.

## Alternatives considered

- **Fork a provider-agnostic OSS engine (OpenCode / Cline).** Best-in-class for a from-scratch start, and Cline's stdin-JSON hooks would have preserved our Python hooks well. Rejected because our differentiator is already 100% `.claude`-native and the SDK loads it directly; a fork re-pays for the harness we already own and still requires wiring Anthropic in. Revisit only if OpenAI/local becomes the co-equal *primary* driver.
- **Build our own loop on `@anthropic-ai/sdk` (extend Athena as-is, no Agent SDK).** Full control, but reinvents the mature, bug-prone parts (context compaction, permissions, subagents, sessions) the Agent SDK already provides.

## Roadmap

- **Phase 0 — Scaffold & de-risk (current).** Stand up the TS SDK skeleton, load a `.claude`-style config, prove a skill triggers, a hook injects, and the provider seam switches Claude↔Kimi. Kill the four-seam unknowns before committing real work. (Live-against-real-Ares proofs run on the Windows host; see the Phase 0 checklist.)
- **Phase 1 — Provider layer.** Capability descriptors; Claude/Kimi/MiniMax direct; OpenAI via pinned LiteLLM sidecar.
- **Phase 2 — Brain port.** Agents, skills, memory/recall, intentions loaded from live Ares; hooks re-hosted; RSI Loop B native.
- **Phase 3 — RSI Loops A + C.** Transcript adapter, `query()` sub-call, scheduler wiring, subagent telemetry emission.
- **Phase 4 — Surfaces.** CLI polish + VS Code extension on the shared core.
- **Phase 5 — Distribution & hardening.** Windows binary, VSIX, fixture/eval gate wired as the release ratchet.

## Open items

- LiteLLM clean-version pin: select and record the exact version.
- Confirm SDK exposes a `Stop`-equivalent re-prompt and `additionalContext` injection (seam 2) — verified in Phase 0.
- Layout: the SDK core lives under `athena-core/`; the legacy Electron shell stays at root as a tool/embodiment source until Phase 4 consumes it.
