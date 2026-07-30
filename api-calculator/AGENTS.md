# API Calculator agent instructions

You are installing a telemetry component into an existing application. Do not ask the operator to design the integration. Inspect the repository, choose the matching framework adapter, and complete the checklist in `SETUP.md`.

The canonical topology is pull-first: the operator names this app in VMP Settings, VMP generates
the random per-app connector key, and VMP later reads this app's HTTPS report. Do not ask for
provider organization/admin keys. Do not invent a second VMP secret. Use the signed push protocol
only when this app cannot expose a reachable report endpoint.

## Non-negotiable behavior

- Observe usage at the provider response boundary. Never estimate tokens from prompt text when the SDK supplies usage.
- Never send prompts, completions, headers, raw API keys, cookies, or user PII to VMP.
- Store the raw provider usage envelope only if the host application's existing privacy policy permits it; otherwise store the normalized scalar meters only. The report must contain normalized scalars only.
- A failed telemetry write must never fail or delay the provider request.
- A missing price is `cost_usd: null` and `pricing_status: "unpriced"`; never coalesce it to zero.
- Preserve provider overlap semantics. OpenAI cached and reasoning tokens are subsets, while Anthropic cache classes are separate meters.
- Include retries as separate attempts with a shared `logical_request_id` when the host app can provide one.
- Tool usage is first-class data: capture tool calls, web search/fetch, grounding, image/audio, and provider-specific billable meters when present.
- Protect the report endpoint with a dedicated per-app bearer secret over HTTPS. Store only its SHA-256 hash in the producer app.
- Add a settings UI section so an operator can see the endpoint, generate/copy the connector key, test the connection, and rotate/revoke it. Never render the secret after save.

## Completion gate

Do not claim completion until all of these are true:

- Every provider call site is either wrapped or explicitly documented as unsupported.
- The report route returns a valid `CalculatorReport` with an empty period when no events exist.
- Unauthorized report requests return 401 before parsing or database work.
- Duplicate event IDs are idempotent.
- Settings UI has generate, copy-once, test, rotate, and revoke states.
- Unit tests cover normalization, overlap handling, auth, idempotency, and unknown pricing.
- Use `adapters/next-report-route.ts` for Next.js App Router producers. The destination app must
  provide a persistent `LedgerStore`; `MemoryLedgerStore` is test/reference only.
- The app's typecheck, lint, test suite, and production build pass.
