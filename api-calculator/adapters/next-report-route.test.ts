import { describe, expect, it } from "vitest";
import { sha256 } from "../src/auth";
import { createVmpReportGet } from "./next-report-route";
import type { CalculatorReport, LedgerStore } from "../src/types";

describe("Next.js report route adapter", () => {
  it("returns 401 before touching the ledger when auth fails", async () => {
    const store: LedgerStore = {
      async insertIfAbsent() {
        throw new Error("not used");
      },
      async listSince() {
        throw new Error("ledger should not be queried before auth");
      },
    };
    const GET = createVmpReportGet({ store, expectedHash: sha256("good-key") });

    const response = await GET(
      new Request("https://producer.example/api/vmp/report", {
        headers: { authorization: "Bearer bad-key" },
      }),
    );

    expect(response.status).toBe(401);
  });

  it("returns a no-store CalculatorReport for authorized requests", async () => {
    const store: LedgerStore = {
      async insertIfAbsent() {
        return "inserted";
      },
      async listSince() {
        return [
          {
            external_id: "attempt-1",
            provider: "openai",
            model: "gpt-test",
            operation: "chat",
            started_at: new Date().toISOString(),
            outcome: "ok",
            meters: [{ name: "prompt_total", value: 10, unit: "token" }],
          },
        ];
      },
    };
    const GET = createVmpReportGet({ store, expectedHash: () => sha256("good-key") });

    const response = await GET(
      new Request("https://producer.example/api/vmp/report?days=7", {
        headers: { authorization: "Bearer good-key" },
      }),
    );
    const body = (await response.json()) as CalculatorReport;

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.schema_version).toBe("v1");
    expect(body.totals.attempts).toBe(1);
  });
});
