# Report route template

Adapt this pseudocode to the destination framework. Keep authorization first. For Next.js App
Router producers, prefer the concrete helper in `adapters/next-report-route.ts`.

```ts
export async function GET(request: Request) {
  const expectedHash = process.env.VMP_REPORT_KEY_HASH ?? "";
  if (!isAuthorized(request, expectedHash)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const days = Number(new URL(request.url).searchParams.get("days") ?? "30");
  const attempts = await readAttempts(ledger, days);
  const report = buildReport(attempts, days, () => null);
  return Response.json(report, { headers: { "Cache-Control": "no-store" } });
}
```

The real implementation should use VMP's current price card when it is calculating locally, or leave `cost_usd` null and let VMP price the raw meters. Do not put pricing secrets or provider keys in this route.
