import { describe, expect, it } from "vitest";
import { buildReport } from "./report";

describe("API calculator", () => {
  it("does not fabricate cost when one meter has no price", () => {
    const report = buildReport([{
      external_id: "a", provider: "openai", model: "gpt-test", operation: "chat",
      started_at: new Date().toISOString(), outcome: "ok", meters: [{ name: "prompt_total", value: 10, unit: "token" }],
    }], 30, () => null);
    expect(report.totals.cost_usd).toBeNull();
    expect(report.totals.pricing_status).toBe("partial");
    expect(report.by_model[0]?.cost_usd).toBeNull();
  });

  it("aggregates priced attempts by model and source", () => {
    const report = buildReport([
      {
        external_id: "a",
        provider: "openai",
        model: "gpt-test",
        operation: "chat",
        source: "assistant",
        started_at: new Date().toISOString(),
        outcome: "ok",
        meters: [{ name: "prompt_total", value: 10, unit: "token" }],
      },
      {
        external_id: "b",
        provider: "openai",
        model: "gpt-test",
        operation: "chat",
        source: "assistant",
        started_at: new Date().toISOString(),
        outcome: "ok",
        meters: [{ name: "prompt_total", value: 5, unit: "token" }],
      },
    ], 30, () => 0.01);

    expect(report.totals.attempts).toBe(2);
    expect(report.totals.cost_usd).toBeCloseTo(0.15);
    expect(report.totals.pricing_status).toBe("priced");
    expect(report.by_model[0]?.meters).toEqual([{ name: "prompt_total", value: 15, unit: "token" }]);
    expect(report.by_source).toHaveLength(1);
    expect(report.by_source[0]?.source).toBe("assistant");
    expect(report.by_source[0]?.attempts).toBe(2);
    expect(report.by_source[0]?.cost_usd).toBeCloseTo(0.15);
  });
});
