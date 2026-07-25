# Threat Model

## Protected assets

- User files outside the selected workspace.
- Repository integrity and Git history.
- Provider keys and unrelated environment secrets.
- Local/private network services and metadata endpoints.
- Session, trace, candidate, and promotion integrity.
- Human authority over policy and code promotion.

## Adversaries

- A malicious cloned repository containing `.athena` configuration.
- Prompt injection in files, webpages, tool output, or MCP results.
- A malicious or compromised MCP server, plugin, hook, or child process.
- A malformed or oversized provider/tool response.
- An improvement candidate optimized to alter its evaluator or hide regressions.

## Controls

- External canonical project trust registry.
- Digest-bound capability approval for hooks and MCP.
- Realpath authorization and sandbox modes.
- Private-address and redirect rejection for network brokers.
- MCP environment allowlist and bounded output.
- Immutable hash-chained traces and signed promotion lineage.
- Protected evaluator/governance paths and isolated experiment worktrees.
- Human approval before code, policy, hook, MCP, or permission promotion.
- Explicit output, duration, call, token, cost, and concurrency limits.

## Residual risk

- Windows restricted shell execution is unavailable and therefore fails closed;
  explicit unrestricted execution has full host authority.
- A trusted plugin or hook remains executable code.
- DNS and network policy implemented in user space cannot equal a kernel egress broker.
- A public held-out suite can be inferred; protection prevents direct modification
  but does not make the cases secret.
- Live provider behavior is nondeterministic and requires repeated observation.
