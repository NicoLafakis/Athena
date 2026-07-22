# Athena

A standalone terminal coding agent: own agentic loop on the Anthropic SDK, Ink TUI,
permission engine, scriptable hooks, sub-agents, and a file-based brain in `~/.athena`.

## Quickstart

    pnpm install
    pnpm build
    npm link          # puts `athena` on PATH
    set ANTHROPIC_API_KEY=sk-ant-...
    cd path/to/your/project
    athena

First run scaffolds `~/.athena` (constitution, settings, memory, skills, agents, hooks, sessions).

## Commands

    athena                 # new session in the current project
    athena --continue      # resume the most recent session here
    athena --resume        # pick a past session
    athena import <path>   # one-time import of an ares-style brain (--force to merge)

In-session: `/help /clear /resume /compact /model /mode /memory /skills /agents /quit`. Esc interrupts a turn.

## Configuration

`~/.athena/settings.json` (global) overlaid by `.athena/settings.json` (per project):
model, permissionMode (`normal | acceptEdits | plan | trusted`), allow/deny rules like
`"Bash(git:*)"` or `"Edit(src/**)"`, and hooks (`SessionStart | UserPromptSubmit | PreToolUse | PostToolUse | Stop`).

## Development

    pnpm typecheck && pnpm lint && pnpm test && pnpm build
