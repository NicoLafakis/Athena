# Permissions and project trust

Two different knobs with similar names; they are deliberately separate, and one can
never impersonate the other.

## The two concepts

- **`permissionMode`** (`normal` | `acceptEdits` | `plan` | `trusted`) gates which tools
  may run, inside `PermissionEngine.check` (`src/harness/permissions.ts`). Precedence is
  fixed: resource-policy containment → read-only sandbox deny → hard deny rules → plan
  mode → read-only allow → allow rules/session grants → mode default. `trusted` is the
  only mode whose default auto-approves every mutating tool, shell included; hard deny
  rules, the resource policy, and `PermissionRequest` hooks still fire first at every
  mode.
- **Project trust** is a per-machine registry record (`src/harness/trust.ts`, keyed by
  the canonical path hash) answering "may this repository influence Athena?" — project
  instructions in the system prompt, project settings, hooks, and MCP servers. It says
  nothing, by itself, about which tools may run.

## The one-way coupling (trust bootstrap)

`resolveTrustBootstrap` (`src/harness/permissions.ts`) runs at composition time
(interactive TUI and `athena voice`; `athena exec` keeps its explicit flag-driven
defaults because it is the headless contract):

- An **explicit registry trust record** for the cwd plus the default `normal` mode →
  the session starts in `trusted` mode. The user's stored trust decision is the only
  thing that can raise the mode this way; a project can never do it for itself —
  `loadSettings` strips project-selected `trusted` mode and `unrestricted` sandbox with
  a warning (`src/brain/settings.ts`).
- The defaulted `trusted=true` a project *without* `.athena/` receives at boot is never
  used here — coupling to that default would make every directory on the machine
  shell-trusted.
- On **win32**, a trusted session with the default `workspace-write` sandbox resolves
  to `unrestricted`: Athena has no Windows sandbox backend, and every other mode makes
  the shell tool fail closed (`resolveSandboxedCommand`, `src/tools/shell.ts`). Linux
  and macOS keep `workspace-write` — bwrap/sandbox-exec provide real containment there.
- An explicit non-`normal` mode or non-default sandbox in the user's own global
  settings is respected unchanged.
- Whenever the bootstrap changes anything it prints one sentence naming the effective
  mode and sandbox (degrade-loudly; silent escalation reads as a bug).

The escape hatches stay in force: `/mode` switches live per session, deny rules still
deny, hooks still intercept, and `athena trust --revoke` removes the record.
