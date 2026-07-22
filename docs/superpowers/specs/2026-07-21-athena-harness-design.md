# Athena Coding Harness — Design Spec

**Date:** 2026-07-21
**Status:** Approved direction (brainstormed with Nico; decisions recorded below)
**Repo:** github.com/NicoLafakis/Athena (`C:\programming\nicos-apps\Athena`)

## 1. Vision

Athena is a standalone, home-built terminal coding agent — a Claude Code-class harness that Nico owns end-to-end. She is the new embodiment of the Ares digital-intelligence design: a named persona with a constitution, persistent file-based memory, skills, enforcement hooks, and sub-agent delegation — but implemented as a real CLI application on the plain Anthropic TypeScript SDK, not as configuration layered on Claude Code.

## 2. Decisions log (from brainstorming, 2026-07-21)

| Decision | Choice |
|---|---|
| Form | Standalone terminal app (own agentic loop), not a config harness |
| Scope | Full harness in one spec: engine, tools, TUI, identity, memory, skills, hooks, sub-agents |
| Persona | The Ares persona ports into Athena and **becomes Athena** — same character architecture, new name |
| Brain data | Athena owns her own directory (`~/.athena`). One-time `athena import <ares-dir>` seeds memories/skills/constitution, rewritten under the Athena identity. No live reference to ares afterward |
| Permissions | Claude Code-style modes + allowlists, PLUS scriptable hook gates as native enforcement |
| Sub-agents | Core feature in v1 |
| Terminal UX | Rich TUI (Ink) |
| Engine | Own harness on the plain Anthropic TS SDK. Explicitly NOT the Claude Agent SDK (which bundles the Claude Code runtime) |

## 3. Architecture

Node/TypeScript CLI (`athena` on PATH, launched in any project directory). One process, four layers with strict boundaries:

```
┌─────────────────────────────────────────────┐
│  TUI (Ink/React)                            │  rendering, input, permission
│  streaming output · diffs · dialogs · /cmds │  dialogs, status line
├─────────────────────────────────────────────┤
│  Harness                                    │  permission engine · hook runner
│  (policy & orchestration)                   │  sub-agent orchestrator · sessions
├─────────────────────────────────────────────┤
│  Engine                                     │  agentic loop (Anthropic SDK)
│  (model loop & tools)                       │  tool registry · context mgmt
├─────────────────────────────────────────────┤
│  Brain (~/.athena)                          │  constitution · memory · skills
│  Athena-owned data, never code              │  agents · hooks · journal · config
└─────────────────────────────────────────────┘
```

Boundary rules:
- **The Engine never talks to the terminal.** It emits typed events (`assistant-text`, `tool-request`, `tool-result`, `turn-done`, `error`); the TUI subscribes. The engine is testable headless, the TUI is swappable, and a future voice/cloud embodiment plugs into the same event stream.
- **The Harness sits between every tool request and execution.** No tool runs (main agent or sub-agent) without passing the permission engine and PreToolUse hooks.
- **The Brain is data, not code.** File formats stay human-readable markdown/JSON.

Repo shape: single package. `bin/athena` entry; `src/engine`, `src/harness`, `src/tui`, `src/brain`, `src/tools`.

## 4. Engine

**Loop.** One turn = user message in → repeat (streaming model call → for each requested tool call: permission check → execute → append result) → until the model stops requesting tools → turn done. Esc interrupts cleanly at the next boundary; the transcript stays coherent.

**SDK.** Plain `@anthropic-ai/sdk` (free/open-source; API spend is sanctioned). Streaming via SSE. Default model configurable in `settings.json`; per-session override via `/model`.

**Context management.** Token accounting per turn. Near the window limit, compact: summarize the older transcript into a structured hand-forward that always preserves (a) the constitution, (b) decisions made this session, (c) the files-modified list. Sessions persist incrementally as JSONL under `~/.athena/sessions/<project-slug>/`; `athena --resume` (picker) and `athena --continue` (most recent).

**System prompt assembly.** One module owns the ordering: constitution (ATHENA.md) → memory index (MEMORY.md) → project context (CLAUDE.md / AGENTS.md / ATHENA.md found in cwd, walking up) → tool guidance → environment block (cwd, platform, git status, date).

## 5. Tools (v1, all built in-house)

| Tool | Notes |
|---|---|
| `Read` | line-numbered output, offset/limit |
| `Write` | create/overwrite; must have Read first to overwrite |
| `Edit` | exact-string replace, uniqueness enforced, `replace_all` |
| `Glob` | fast file pattern matching |
| `Grep` | ripgrep-backed content search |
| `Bash` / `PowerShell` | shell execution, timeout, background mode |
| `WebFetch` | fetch + readable extraction |
| `WebSearch` | web search |
| `TodoWrite` | task list, rendered live in TUI |
| `Agent` | spawn sub-agent (Section 7) |
| `Memory` | read/write Brain memory files in-session |

Each tool = one module: typed JSON schema, model-facing description, executor, unit tests. Tool results are size-capped with truncation notices. **MCP client support is a designed seam (tool registry accepts external providers) but not in the first build.**

## 6. Harness: permissions + hooks

**Permission modes:** `normal` (mutating actions prompt), `acceptEdits` (file edits auto-approved; shell still prompts), `plan` (read-only tools only), `trusted` (no prompts; hook gates still enforce). Mode switchable live via `/mode`.

**Allowlist rules** in `settings.json` — matcher syntax `Tool(pattern)`: e.g. `Bash(git:*)`, `Read(**)`, `Edit(src/**)`. Session-scoped "always allow this" grants from the permission dialog. A hard deny list that no mode bypasses.

**Hook runner.** Events: `SessionStart`, `UserPromptSubmit`, `PreToolUse` (can deny), `PostToolUse`, `Stop`. Hooks are user-supplied executables declared in `settings.json` with tool matchers; they receive event JSON on stdin and speak via exit codes + stdout JSON (deny with reason / allow / annotate context). Timeouts enforced. This is how ares-style structural gates (SOP commit gate, protected paths, delegation rules) port over as **data in the Brain, not code in the app**.

## 7. Sub-agents

`Agent` tool spawns child engine instances: own context, own (restricted) tool set, same permission engine and hook runner as the parent. Agent definitions are markdown files with frontmatter (`name`, `description`, `tools`, `model`) in `~/.athena/agents/` (global) and `.athena/agents/` (per-project). Parallel spawning; background execution with completion notification into the parent transcript; parent can send follow-up messages to a running agent. Sub-agents cannot spawn sub-agents (one level, v1).

## 8. Brain (`~/.athena/`)

```
~/.athena/
  ATHENA.md          # constitution: identity + global rules
  settings.json      # model, permissions, hooks, allowlists
  memory/            # one fact per file + MEMORY.md index (ares format)
  skills/            # SKILL.md format, frontmatter descriptions
  agents/            # sub-agent definitions
  hooks/             # user hook scripts
  sessions/          # per-project JSONL transcripts
  journal/           # session activity capture
```

Per-project overlay: `.athena/` in a repo can carry project-local settings, agents, and hooks (same precedence idea as Claude Code's project settings).

**Import.** `athena import <path>` — one-time inheritance from an ares-style directory: copies memory, skills, agent defs, and constitution; rewrites identity references (Ares → Athena, persona name in constitution and memory frontmatter); reports what was imported and what needs manual review. After import there is no live link, no sync, no reference to the source. Skipping import = fresh brain, same formats.

**Skills.** Loaded at session start as an index (name + description); full SKILL.md content injected when invoked (by the model or via `/skill`). Same progressive-disclosure model ares relies on.

## 9. TUI (Ink)

- Streaming assistant output with markdown rendering (headings, code blocks, tables degrade gracefully)
- Tool-call cards: collapsed one-liners expanding to full I/O; diff previews for Write/Edit
- Permission dialog: allow once / always allow (writes rule) / deny, with the exact action shown
- Slash commands: `/help /clear /resume /compact /model /mode /memory /skills /agents /quit`
- Status line: cwd, git branch, model, mode, context-usage %
- Esc interrupts the turn; input history (up/down); multiline input
- TodoWrite list rendered as a live checklist panel

## 10. Error handling

- Tool failures return as tool-result errors to the model — never crash the app
- API errors: retry with exponential backoff; surfaced in the TUI status line; hard failures end the turn with the transcript intact
- Session files written incrementally — a crash loses at most the in-flight message
- Hook script failures: fail-closed for PreToolUse deny-capable hooks (a broken gate blocks, not bypasses), fail-open with a warning for observational hooks

## 11. Testing

- **Unit** (Vitest): every tool executor; permission matcher; hook runner; context compactor; prompt assembler; import rewriter
- **Integration:** full engine loop against a mocked Anthropic client (scripted tool-use conversations); permission flows end-to-end
- **Smoke:** boot the TUI headless (ink-testing-library), run a scripted session
- **Gates:** `pnpm typecheck` → `pnpm lint` → `pnpm test` → `pnpm build` before any push, per SOP

## 12. Tech stack

TypeScript (strict), Node ≥ 20, pnpm. Deps (all free/open-source): `@anthropic-ai/sdk`, `ink` + `react`, `@vscode/ripgrep` (bundled rg), `zod` (schemas/validation), `vitest`, `tsup` (build). Lean by design; anything else needs justification.

## 13. Out of scope, v1 (designed seams, not features)

- MCP client support (tool-registry seam exists)
- Voice embodiment; cloud/scheduled runs (engine event stream is the seam)
- Workflow-style deterministic multi-agent orchestration (Agent tool is the seam)
- Windows-Terminal-specific polish beyond Ink defaults; theming
- Auto-updater / packaged installers (npm-linked bin is fine for v1)
