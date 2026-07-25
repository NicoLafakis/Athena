# Design

## Runtime boundaries

```text
CLI / TUI
   |
   v
Engine + RunBudget ----> immutable RunTrace
   |
   +--> PermissionGate --> ResourcePolicy --> built-in tools
   |                                |
   |                                +--> OS shell sandbox (fail closed)
   |
   +--> HookRunner / MCP / managed plugins
   |
   +--> AgentOrchestrator --> durable child run + optional git worktree
```

Project-local configuration is loaded in a safe mode until the canonical project
path is trusted. Hook and MCP definitions receive separate approvals bound to the
stable digest of their exact configuration.

Filesystem tools resolve existing path components through real paths at use time.
Network brokers resolve and reject private/local destinations, revalidate redirects,
and cap response bodies while streaming. Shell containment uses bubblewrap on
Linux and `sandbox-exec` on supported macOS hosts. Restricted shell execution
fails closed when an OS adapter is unavailable.

## Automation

`athena exec` uses the same `Engine` as the TUI. Its result envelope and JSONL
events are versioned. `RunBudget` accounts for cumulative model calls, tool calls,
tokens, cost, duration, and concurrency. Model capabilities provide context,
output, feature, and pricing limits used before requests.

## Persistence

Sessions are append-only event logs with locking and atomic metadata operations.
Run traces are separate append-only JSONL chains where each record hashes its
predecessor. Child traces carry `parentRunId`. Session delete and plugin removal
move data to recoverable trash locations.

## Learning plane

```text
verified immutable trace(s)
          |
          v
typed provisional candidate
          |
          v
baseline worktree <--> candidate worktree
          |
          v
protected held-out comparison + safety/cost/latency/tool gates
          |
          v
explicit human approval --> canary --> measured canary --> finalize
                                      |
                                      +--> rollback
```

Candidates cannot modify held-out suites, workflow governance, or the learning
implementation. Promotion records form an Ed25519-signed append-only lineage.
