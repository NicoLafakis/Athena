# Athena Harness Parity Program

This package turns the findings in
[the 2026-07-24 baseline evaluation](../athena-harness-parity-evaluation-2026-07-24.md)
into an implementation and verification contract.

The program has two distinct targets:

1. **Selected standard-harness parity:** the observable CLI, safety, session,
   extension, and automation behaviors explicitly selected in the baseline.
2. **Governed recursive improvement:** a separate evidence loop that may propose,
   evaluate, canary, promote, and roll back changes without granting an
   unconstrained self-edit path.

Athena is not represented as a binary-identical clone of Claude Code or Codex.
Those products include proprietary services and surfaces outside this repository.
The maintained claim is behavioral compatibility for explicitly selected,
checked-in scenarios. Deliberate exclusions are listed in the
[implementation report](../athena-harness-parity-implementation-report-2026-07-24.md).

## Document map

- [Requirements](requirements.md)
- [Product requirements](prd.md)
- [Design](design.md)
- [Tasks and evidence](tasks.md)
- [Test strategy](test-strategy.md)
- [Threat model](threat-model.md)
- [Observability](observability.md)
- [NFR budgets](nfr-budgets.md)
- [Rollout](rollout.md)
- [Risks](risks.md)
- [Parity-contract ADR](adr-001-observable-parity-contract.md)
- [Learning-governance ADR](adr-002-governed-learning.md)
