import { isAuthorized } from "../src/auth";
import { readAttempts } from "../src/ledger";
import { buildReport, type PriceLookup } from "../src/report";
import type { LedgerStore } from "../src/types";

interface ReportRouteOptions {
  store: LedgerStore;
  expectedHash: string | (() => string);
  price?: PriceLookup;
}

export function createVmpReportGet(options: ReportRouteOptions) {
  return async function GET(request: Request): Promise<Response> {
    const expectedHash =
      typeof options.expectedHash === "function" ? options.expectedHash() : options.expectedHash;

    if (!isAuthorized(request, expectedHash)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    const days = Number(new URL(request.url).searchParams.get("days") ?? "30");
    const attempts = await readAttempts(options.store, days);
    const report = buildReport(attempts, days, options.price ?? (() => null));

    return Response.json(report, {
      headers: { "Cache-Control": "no-store" },
    });
  };
}
