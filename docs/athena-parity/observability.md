# Observability

## Run evidence

Every parent and child run receives a unique ID and an append-only JSONL trace.
Records include schema version, parent lineage, sequence, timestamp, payload,
previous hash, and current hash. The warehouse rejects an invalid chain as
learning provenance.

The final run record contains cumulative:

- input, output, cache-read, and cache-write tokens;
- model and tool calls;
- cost;
- turns and duration;
- terminal status and reason.

## Operator surfaces

- `athena exec --output json|jsonl`
- `athena learn traces`
- `athena learn candidates`
- `athena learn lineage`
- `athena doctor [--json]`
- durable session and child-run records
- CI and live-canary artifacts

## Alerts and retention

CI failures block integration. Live-canary output is retained as a 30-day
artifact. The workflow fails when the result is non-completed, the exit code is
nonzero, output-schema validation fails, or the configured cost ceiling is
exceeded. Secrets are redacted before session persistence and never written to
the trace by the credential subsystem.
