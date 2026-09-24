# VMP API Calculator

Copy this directory into an application that makes AI/provider calls. The destination app's coding agent must read `AGENTS.md` before changing anything.

The calculator observes provider responses inside the producer app, stores sanitized usage locally,
exposes a read-only report endpoint, and lets Vibe Monitor Plus pull that report with the **random
per-app key generated in VMP Settings**. Pull is the first method; signed push is only a fallback.
It never requires provider organization keys and never transmits prompts, completions, or raw
provider credentials.

## Quick start for an agent

1. Read `AGENTS.md` completely.
2. Read `SETUP.md` and the provider notes in `docs/providers/`.
3. Inventory the app's provider call sites and its settings route before editing.
4. Copy `src/` into the app's server-side library area, preserving the module boundaries.
5. Copy the relevant `adapters/` template. Use `adapters/next-report-route.ts` for a Next.js App
   Router app, and use `adapters/memory-ledger.ts` only as a test/reference adapter.
6. Add the environment variables listed in `SETUP.md`.
7. Add the protected report route and the settings UI connection field exactly as described.
8. Wrap every provider call site, including retries and tool-enabled calls.
9. Run the app's typecheck, lint, tests, and production build.
10. In VMP Settings, name the app, generate/retrieve its key, enter the report URL, and test the
   connector. Keep the VMP-generated key as the only trust credential for this app.

## Included tests and adapters

The kit includes Vitest coverage for normalization, provider overlap handling, report auth,
idempotent ledger writes, route auth ordering, and unknown pricing. Keep those tests or equivalent
destination-app tests after copying the kit.

`adapters/next-report-route.ts` is the framework-specific route helper for Next.js App Router
producers. The destination app still supplies the persistent `LedgerStore`; the included
`MemoryLedgerStore` is for tests and examples, not production persistence.

## Contract

The stable wire contract is `src/contract.ts`. A producer returns a JSON document with period, totals, model usage, source usage, and detailed meters. VMP prices the raw meter values using its versioned price card. Unknown prices remain `null` and are marked `unpriced`.

## Design references

- VMP pricing engine: `../.wiki/token-monitor/claude-plan/05-pricing-engine.md`
- VMP collector design: `../.wiki/token-monitor/claude-plan/04-collectors.md`
