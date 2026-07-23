# Athena

A standalone terminal coding agent: own agentic loop on the Anthropic SDK, Ink TUI,
permission engine, scriptable hooks, sub-agents, and a file-based brain in `~/.athena`.

## Quickstart

    pnpm install
    pnpm build
    npm link          # puts `athena` on PATH
    cd path/to/your/project
    athena

On first run Athena asks you to pick a provider (Anthropic, Kimi/Moonshot, or Kimi Code) and paste
an API key — input is hidden, the key is validated live, then saved to
`~/.athena/credentials.json` and the session starts. No shell environment setup needed.

    athena auth            # add/replace keys or switch the default provider any time
    athena auth status     # configured providers, active provider, redacted keys

First run also scaffolds `~/.athena` (constitution, settings, memory, skills, agents, hooks, sessions).

## Commands

    athena                 # new session in the current project
    athena --continue      # resume the most recent session here
    athena --resume        # pick a past session
    athena --provider kimi # session-only override (first-time setup adopts it as default)
    athena auth            # setup wizard: keys + default provider
    athena auth status     # redacted key/provider overview
    athena import <path>   # one-time import of an ares-style brain (--force to merge)

In-session: `/help /clear /resume /compact /model /effort /provider /mode /memory /skills /agents /quit`. Esc interrupts a turn.

## Configuration

`~/.athena/settings.json` (global) overlaid by `.athena/settings.json` (per project):
model is a key of the ACTIVE provider (`haiku | sonnet | opus | fable` for Anthropic,
`kimi-k3 | kimi-k2.7-code | kimi-k2.6` for Kimi, `kimi-for-coding | k3 | k3[1m]` for
Kimi Code — a legacy/full id like `claude-opus-4-8` is also
accepted and normalized), effort (`low | medium | high | xhigh | max`; applies to
Sonnet/Opus/Fable, which also run adaptive thinking — Haiku and all Kimi models ignore
it), permissionMode (`normal | acceptEdits | plan | trusted`), allow/deny rules like
`"Bash(git:*)"` or `"Edit(src/**)"`, and hooks (`SessionStart | UserPromptSubmit |
PreToolUse | PostToolUse | Stop`).
Switch live with `/model <key>`, `/effort <level>`, and `/provider <anthropic|kimi|kimi-code>`
(`/provider` is session-only; `athena auth` changes the persisted default).

### Providers

- **Anthropic** — default SDK endpoint; console API key from console.anthropic.com.
- **Kimi (Moonshot)** — Anthropic-compatible endpoint `https://api.moonshot.ai/anthropic`;
  pay-per-token key from platform.kimi.ai. Kimi models do not support the effort dial or
  extended thinking; Athena omits those request fields automatically.
- **Kimi Code (subscription)** — Kimi-for-Coding subscription endpoint
  `https://api.kimi.com/coding/`; key from kimi.com/code/console. Models:
  `kimi-for-coding` (all tiers), `k3` (256K context) and `k3[1m]` (1M context) — the
  latter two need the Moderato tier or above. Subscription keys are NOT interchangeable
  with pay-per-token keys: each works only against its own provider.

### Advanced: env-var override

Keys normally live in `~/.athena/credentials.json` (written by the wizard with
owner-only permissions where the OS supports it). If `ANTHROPIC_API_KEY`,
`MOONSHOT_API_KEY`, or `KIMI_CODE_API_KEY` is set in the environment, it overrides the
file for that provider —
useful for CI or ephemeral machines. `athena auth status` shows when an override is
active.

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
