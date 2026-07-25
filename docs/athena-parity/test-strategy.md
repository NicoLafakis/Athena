# Test Strategy

## Layers

1. **Unit and property-like invariants:** permissions, real paths, budgets, schemas,
   atomicity, bounded buffers, signature verification, and state transitions.
2. **Fixture-provider process tests:** invoke the built CLI without paid network
   calls and verify stdin, JSON/JSONL, schemas, traces, exits, and budgets.
3. **Protected held-out suite:** `evals/heldout/athena-parity-v1.json` covers trust,
   sandbox paths, SSRF, headless execution, and governed learning.
4. **Live canary:** a scheduled/manual bounded provider call, skipped when its
   dedicated secret is absent.

## Required gates

```text
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

CI runs these gates on Node 20 and 22 for Ubuntu, Windows, and macOS.

## Learning acceptance

- At least five paired held-out cases.
- Positive paired 95% lower-confidence bound.
- No newly failing previously passing case.
- No safety-invariant regression.
- Candidate cost no more than 1.2x baseline.
- Candidate latency and tool calls no more than 1.25x baseline.
- Exact candidate patch must remain reversible through canary and rollback.
