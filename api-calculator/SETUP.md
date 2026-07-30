# End-to-end installation runbook

This is the canonical producer-side setup for VMP. **Pull is the primary method.** VMP Settings
generates the app key; the destination app does not invent one and does not need an OpenAI,
Anthropic, Gemini, or Kimi organization key. The producer records usage locally and exposes a
sanitized HTTPS report that VMP reads every 30 minutes and on demand.

## 1. Inventory the destination app

Find the provider SDK/fetch call sites, the server-side settings page, the app's persistent database or key-value store, and its deployment URL. Do not edit client bundles with provider credentials.

## 2. Install the server library

Copy `src/types.ts`, `src/contract.ts`, `src/normalize.ts`, `src/report.ts`, `src/auth.ts`,
`src/pricing.ts`, and `src/ledger.ts` into the app's server-only library directory. Copy the
relevant files from `adapters/`:

- `adapters/next-report-route.ts` for Next.js App Router report endpoints.
- `adapters/memory-ledger.ts` only for tests, local examples, and as the shape of a real
  `LedgerStore` implementation.

Adapt the `LedgerStore` interface to the app's existing database. Do not introduce a second
database merely for telemetry.

## 3. Configure secrets

After the operator names this app in VMP Settings and clicks **Generate key**, add these
server-only variables:

```text
VMP_REPORT_KEY_HASH=<sha256 of the VMP-generated connector key>
VMP_REPORT_KEY_VERSION=1
VMP_REPORT_URL=https://<this-app>/api/vmp/report
```

The raw connector key is generated and retained by VMP (encrypted at rest). Copy it into the
producer only long enough to derive/store its SHA-256 hash. Never log it or commit it. VMP can
reveal the retained value later, and rotate/revoke it from Settings.

The app's existing provider keys remain where they already live. Do not copy them into VMP.

## 4. Add the report endpoint

Create `GET /api/vmp/report` (or the framework equivalent) using `src/auth.ts` before any request parsing or database access. For Next.js App Router, use `adapters/next-report-route.ts` and export:

```ts
export const GET = createVmpReportGet({
  store: persistentLedgerStore,
  expectedHash: () => process.env.VMP_REPORT_KEY_HASH ?? "",
});
```

The endpoint must:

- require `Authorization: Bearer <connector key>`;
- accept `days` (default 30, maximum 365);
- query the local ledger;
- return `CalculatorReport` JSON;
- return 401 for invalid credentials and 200 with zero totals for an empty ledger.

The endpoint is read-only and must be HTTPS-only in deployment.

## 5. Instrument provider calls

At every provider response boundary, call `recordAttempt()` with the provider's actual usage object. Use the provider guides in `docs/providers/` and map all available tool meters. Wrap retries separately, retaining a shared logical request id.

Minimum fields: provider, model, operation, started_at, outcome, external_id, and meters. Include `credential_ref` only as a non-secret label/fingerprint; never include raw key material.

## 6. Add the settings UI

Add a “VMP API Calculator” section to the existing settings dashboard/menu, not a new standalone admin app. It must show:

- connection status;
- report URL with a copy button;
- connector key is supplied by VMP; the producer settings show connection status and report URL;
- “Test connection” action;
- rotate and revoke actions;
- last successful report time and event count.

Use the app's existing auth/role gate. Mutations must be server actions/API routes. The raw key is write-only and must never be returned by a normal read query.

## 7. Connect VMP

In VMP's Settings connector UI, enter this app's report URL and paste the generated key into the
producer configuration. Test the connection, then leave the connector active. VMP polls every 30
minutes and supports manual refresh. If the destination app is not publicly reachable, document
that it cannot use the preferred pull method and use the compatibility push path instead.

## 8. Compatibility push fallback

Only when a producer cannot expose a reachable HTTPS report, use the signed `/api/ingest` protocol
in `PROTOCOL_APP_INSTRUMENTATION.md`. Treat that as a transport fallback, not a different pricing
or collection architecture. The producer still observes and stores the same normalized meters.

## Athena CLI host adapter

When installing this kit into the Athena terminal harness, the integration is already
wired:

- `src/engine/telemetry.ts` builds normalized attempts.
- `src/brain/vmp-ledger.ts` implements `LedgerStore` as `~/.athena/vmp-ledger.jsonl`.
- `src/engine/client.ts` records every Anthropic-compatible provider call.
- `src/harness/vmp.ts` serves the report via `athena vmp server`.
- `athena vmp configure --url <url> --key-hash <hash>` persists connector settings.

No settings UI screen is required; configuration is file- and CLI-based.

## 9. Verify

Make one real provider call in a non-production/test environment. Confirm the local ledger contains one attempt, the report contains matching meters, an invalid bearer returns 401, and VMP can pull the report. Then run the destination app's full verification commands and deploy.

The copied kit must retain or recreate tests for:

- normalization, including invalid meter values;
- provider overlap semantics: OpenAI subset meters and Anthropic disjoint cache meters;
- report authorization and auth-before-ledger route ordering;
- idempotent `external_id` writes;
- unknown pricing as `cost_usd: null`, never zero.
