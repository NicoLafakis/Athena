# Requirements

Status is measured against the implementation in this change.

| ID | Requirement | Status | Primary evidence |
|---|---|---|---|
| SAFE-01 | Canonical project trust outside the repository | Complete | `src/harness/trust.ts`, trust tests |
| SAFE-02 | Separate digest-bound project hook and MCP approval | Complete | trust/settings/CLI tests |
| SAFE-03 | Read-only, workspace-write, and explicit unrestricted policy | Partial | resource policy and shell sandbox tests; no native Windows process sandbox |
| SAFE-04 | Realpath and symlink-safe filesystem authorization | Complete | resource-policy tests |
| SAFE-05 | MCP environment allowlist and bounded protocol output | Complete | MCP tests |
| SAFE-06 | SSRF-safe web broker with redirect and response limits | Complete | WebFetch tests |
| SAFE-07 | Bounded I/O, atomic writes, process cleanup | Complete | tool/session/shell tests |
| AUTO-01 | Headless prompt or stdin execution | Complete | `athena exec`, process integration tests |
| AUTO-02 | Text, JSON, JSONL, output schema, stable exit codes | Complete | CLI integration tests |
| AUTO-03 | Model/tool/token/cost/time/concurrency budgets | Complete | engine run tests |
| AUTO-04 | Model-specific context/output/pricing capabilities | Complete | model/context tests |
| OBS-01 | Immutable complete parent and child run traces | Complete | trace and child-agent tests |
| OBS-02 | Cross-platform production CI | Complete | `.github/workflows/ci.yml` |
| SESSION-01 | Collision-safe durable sessions and visible resume | Complete | session and TUI resume tests |
| SESSION-02 | Checkpoint, rewind, fork, rename, search, recoverable delete | Complete | session tests and CLI |
| AGENT-01 | Durable child status, follow-up, resume, limits, cancellation | Complete | agent tests |
| AGENT-02 | Bounded concurrency and worktree isolation for mutation | Complete | agent scheduler/worktree tests |
| EXT-01 | Progressive skills with support resources | Complete | skill tests |
| EXT-02 | Versioned bounded lifecycle hooks and hook adapters | Complete | hook tests |
| EXT-03 | MCP stdio and Streamable HTTP with authentication | Partial | client-credentials OAuth is supported; interactive authorization-code login is not |
| EXT-04 | Managed versioned plugin lifecycle and verification | Complete | plugin tests |
| TOOL-01 | Patch, image input, notebook edit, diagnostics | Complete | richer-tools tests |
| TOOL-02 | Interactive browser/computer control | Deliberate exclusion | available through an MCP server, not a built-in Athena tool |
| AUTH-01 | OS credential-vault adapters and migration | Complete | credential tests |
| OPS-01 | Diagnostics and explicit update policy | Complete | `athena doctor`; source-only reviewed update policy |
| LEARN-01 | Verified trace warehouse and evaluator registry | Complete | learning warehouse/evaluation tests |
| LEARN-02 | Typed candidates and memory provenance/consolidation | Complete | candidate and memory tests |
| LEARN-03 | Isolated baseline/candidate held-out comparison | Complete | evaluation tests |
| LEARN-04 | Human gate, signed lineage, canary, finalize, rollback | Complete | promotion end-to-end test |
| LEARN-05 | Repeated real-world measured improvement | Partial | deterministic delta is proven; production live delta has not yet been accumulated |

The selected baseline contains 30 requirements: 25 complete, four partial, and
one deliberate exclusion. Counting partial/excluded items as half credit gives a
requirement-closure measure of **91.7%**. This is not the same as literal product
parity.
