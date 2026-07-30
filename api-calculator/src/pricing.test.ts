import { describe, expect, it } from "vitest";
import { createPriceLookup } from "./pricing";

describe("API calculator pricing lookup", () => {
  it("matches exact and wildcard model records", () => {
    const price = createPriceLookup([
      {
        provider: "openai",
        model_pattern: "gpt-5*",
        meter: "prompt_total",
        usd_per_unit: 0.000001,
        effective_from: "2026-01-01",
        source_url: "https://example.test/pricing",
        version: "test",
      },
    ]);

    expect(price("openai", "gpt-5.1", { name: "prompt_total", value: 1, unit: "token" })).toBe(0.000001);
    expect(price("openai", "gpt-4.1", { name: "prompt_total", value: 1, unit: "token" })).toBeNull();
  });

  it("returns null for unknown prices so producers do not fabricate cost", () => {
    const price = createPriceLookup([]);

    expect(price("kimi", "unknown-model", { name: "prompt_total", value: 1, unit: "token" })).toBeNull();
  });
});
