# Rollout

## Stage 1: deterministic validation

Run typecheck, lint, the complete test suite, and build locally and in the
cross-platform matrix. Confirm help/version/doctor do not require provider auth.

## Stage 2: fixture automation

Exercise `athena exec` with the fixture provider and inspect versioned result
envelopes and valid trace chains. Run the protected parity suite.

## Stage 3: live canary

Configure only `ATHENA_CANARY_ANTHROPIC_API_KEY` in the repository secret store.
Run the workflow manually before enabling reliance on the weekly schedule.
The canary has no tool allowance, an output schema, a two-call ceiling, a
120-second timeout, an 8,000-token ceiling, and a USD 0.05 cost ceiling.

## Stage 4: governed candidate

Admit a trace-backed provisional candidate, run isolated evaluation, inspect the
exact diff and comparison, explicitly approve a canary, measure it, then finalize
or roll back. Do not automate human approval.

## Rollback

- Code deployment: revert the release commit.
- Plugin: disable or remove it; removal is recoverable.
- Session: fork/rewind from a durable checkpoint.
- Learning candidate: `athena learn rollback <candidate-id>`.
- Trust: `athena trust --revoke`.
