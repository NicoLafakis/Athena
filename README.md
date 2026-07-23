# Athena

A standalone terminal coding agent: own agentic loop on the Anthropic SDK, Ink TUI,
permission engine, scriptable hooks, sub-agents, and a file-based brain in `~/.athena`.

## Quickstart

    pnpm install
    pnpm build
    npm link          # puts `athena` on PATH
    cd path/to/your/project
    athena

Set your API key first:

    # PowerShell (current session)
    $env:ANTHROPIC_API_KEY = "sk-ant-..."

    # PowerShell (persist for future sessions, then reopen the shell)
    [Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY","sk-ant-...","User")

    # bash/zsh
    export ANTHROPIC_API_KEY=sk-ant-...

First run scaffolds `~/.athena` (constitution, settings, memory, skills, agents, hooks, sessions).

## Commands

    athena                 # new session in the current project
    athena --continue      # resume the most recent session here
    athena --resume        # pick a past session
    athena import <path>   # one-time import of an ares-style brain (--force to merge)

In-session: `/help /clear /resume /compact /model /effort /mode /memory /skills /agents /quit`. Esc interrupts a turn.

## Configuration

`~/.athena/settings.json` (global) overlaid by `.athena/settings.json` (per project):
model (`haiku | sonnet | opus | fable` — a legacy/full id like `claude-opus-4-8` is also
accepted and normalized), effort (`low | medium | high | xhigh | max`; applies to
Sonnet/Opus/Fable, which also run adaptive thinking — Haiku ignores it), permissionMode
(`normal | acceptEdits | plan | trusted`), allow/deny rules like `"Bash(git:*)"` or
`"Edit(src/**)"`, and hooks (`SessionStart | UserPromptSubmit | PreToolUse | PostToolUse | Stop`).
Switch either live with `/model <family>` and `/effort <level>`.

## Security model

Permission rules for file tools are matched in canonical-absolute coordinates:
both the rule pattern and the tool's `file_path` are resolved against the
session cwd (backslashes folded to `/`, `.`/`..` segments resolved,
case-insensitive on Windows) — the same resolution the tools themselves apply.
Relative rules like `Edit(src/**)` anchor at the project the session runs in,
and neither `a/../secret/x` nor a `../` escape from a sub-directory can bypass
a deny rule like `Write(C:/vault/**)`.

Note that this anchoring applies wherever a rule lives: a relative pattern in
the **global** `~/.athena/settings.json` still resolves against the directory
Athena was launched in, so `Edit(src/**)` there means `<launch dir>/src/**` and
its meaning changes per project. Use absolute patterns in global settings when
you mean a fixed location.

The `Bash(...)`/`PowerShell(...)` command **prefix filter is advisory only**:
shell metacharacters, subshells, and env tricks can evade a string prefix.
Real enforcement is the permission ask (mutating tools are deny-by-default
outside `trusted` mode) plus PreToolUse hooks; command deny rules are a
convenience guardrail, not a sandbox.

## Development

    pnpm typecheck && pnpm lint && pnpm test && pnpm build
