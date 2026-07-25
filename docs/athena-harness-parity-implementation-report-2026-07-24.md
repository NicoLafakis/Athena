# Athena Harness Parity Implementation Report

**Date:** 2026-07-24

**Baseline:** `6f5864c` and
[`athena-harness-parity-evaluation-2026-07-24.md`](athena-harness-parity-evaluation-2026-07-24.md)

**Assessment:** verified implementation in this change

## Verdict

Athena moved from a capable but unsafe/interactive-only v1 to a bounded,
automatable, traceable harness with a governed learning plane. It closes **91.7%**
of the 30 explicitly selected implementation requirements when partial and
deliberately excluded items receive half credit.

It still does **not** have literally the same capabilities as current Claude Code
or Codex. On a strict current observable-product rubric, Athena is **84/100**, up
from the 43/100 baseline. The remaining difference is no longer the basic
agent/tool loop; it is concentrated in native Windows containment, interactive
MCP OAuth, browser/computer control, plugin marketplaces, multi-session/team
operator surfaces, proprietary account/cloud integrations, and real-world
longitudinal proof of recursive improvement.

## Updated scorecard

| Dimension | Weight | Score | Current assessment |
|---|---:|---:|---|
| Core model/tool loop | 15 | 14 | Preflight context, cumulative usage, retries, limits, compaction accounting |
| Built-in tool plane | 12 | 9.5 | Patch/image/notebook/diagnostics and bounds; no built-in interactive browser/computer |
| Security, trust, containment | 15 | 12 | Trust, real paths, SSRF, environment limits; Windows restricted shell fails closed |
| Context and sessions | 10 | 9 | Model-aware context and reconstructable checkpoint/fork/rewind lifecycle |
| Subagents and concurrency | 10 | 8 | Durable limited children and worktrees; no full agent-view/team product |
| Skills, hooks, MCP, plugins | 12 | 9.5 | Broad extension semantics; OAuth/login and marketplace surface remain narrower |
| Automation and composability | 10 | 9.5 | Shared-engine `exec`, stdin, JSON/JSONL/schema, budgets, stable exits |
| Operator/TUI experience | 6 | 4.5 | Resume history and live child/shell events; fewer fleet/operator views |
| Observability and evaluations | 5 | 4 | Immutable traces, CI, held-out suite, live workflow; scheduled evidence not yet accumulated |
| Recursive self-improvement | 5 | 4 | Governed L4 mechanism; repeated real-world L5 gain not yet proven |
| **Total** | **100** | **84** | **Strong selected-contract implementation, not literal drop-in identity** |

## Baseline finding closure

| Baseline finding | Result |
|---|---|
| Untrusted project startup execution | Closed with canonical trust and separate digest approvals |
| Advisory-only boundaries and SSRF | Closed for built-in file/web tools; process sandbox is platform-dependent and fail-closed |
| No non-interactive contract | Closed with `athena exec` |
| Fixed context and incomplete usage | Closed with model capabilities, preflight, cumulative accounting, and cost |
| Unbounded parent/child loops | Closed with run budgets, cancellation ancestry, scheduler limits, and durable children |
| Basic/invisible session resume | Closed with append-only sessions and visible lifecycle |
| Narrow extensions | Substantially closed across skills, hooks, MCP, and managed plugins |
| Unbounded/blocking tools | Closed with producer-side caps, streaming, atomic patching, ownership, and cleanup |
| No outcome evaluations | Closed at deterministic/fixture/held-out/workflow layers; live history pending |
| Broken fresh import/bootstrap | Closed and process-tested |
| Startup/crash side effects | Closed for help/version/import and coordinated fatal cleanup |
| Plaintext-only secrets | Closed with OS vault adapters and migration; enterprise auth remains out of scope |

## Recursive improvement result

The implementation now contains every stage of the governed loop:

1. immutable verified run and child-run evidence;
2. typed candidates with hypothesis, patch, metrics, scope, counterexamples,
   confidence, expiry, and provenance;
3. isolated baseline/candidate worktrees;
4. protected held-out comparisons with a paired lower-confidence bound;
5. no-regression safety, cost, latency, and tool-use gates;
6. explicit human approval;
7. signed append-only version lineage;
8. canary, finalize, consolidation, and rollback.

The deterministic end-to-end test proves that the mechanism can measure a
baseline/candidate delta and reverse a promoted change. Operational maturity is
therefore **L3 evidenced / L4 implemented**. L5 remains unclaimed until repeated
real tasks demonstrate durable improvement after promotion.

## Deliberate and residual non-parity

- Restricted shell calls fail closed on Windows because Athena has no native
  Windows sandbox adapter. Explicit unrestricted mode works but carries host authority.
- Interactive browser/computer control is an MCP integration surface, not a
  built-in tool.
- MCP HTTP supports bearer/static headers and client-credentials OAuth, not an
  interactive authorization-code login flow.
- Plugins install from local or Git sources and support lifecycle/signatures, but
  Athena has no browsable marketplace registry.
- Provider auth is API-key/vault based; subscription login and enterprise
  Bedrock/Vertex/account administration are not reproduced.
- Updates are reviewed source upgrades, not a silent self-updater.
- Athena does not reproduce proprietary cloud tasks, desktop/IDE products, agent
  fleets/teams, or vendor-operated telemetry.

## Verification assets

- `.github/workflows/ci.yml`
- `.github/workflows/live-canary.yml`
- `evals/heldout/athena-parity-v1.json`
- `tests/cli/exec.integration.test.ts`
- `tests/harness/trust.test.ts`
- `tests/harness/resource-policy.test.ts`
- `tests/harness/traces.test.ts`
- `tests/learning/evaluation.test.ts`
- `tests/learning/warehouse.test.ts`

Final local verification on Windows:

- typecheck: passed;
- lint: passed;
- tests: **649 of 649 passed across 76 test files**;
- production build: passed;
- built CLI smoke checks: `--help`, `exec --help`, `--version`, and
  `doctor --json` passed.

The release commit identifier is reported at handoff rather than embedded in the
commit that it identifies.

## Current reference surface

- [Claude Code extension overview](https://code.claude.com/docs/en/features-overview)
- [Claude Code subagents](https://code.claude.com/docs/en/sub-agents)
- [Claude Code parallel agents and worktrees](https://code.claude.com/docs/en/agents)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Codex developer commands](https://developers.openai.com/codex/cli/reference/)
- [Codex configuration](https://developers.openai.com/codex/config-reference/)
- [Codex MCP](https://developers.openai.com/codex/mcp/)
