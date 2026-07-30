import { describe, expect, it } from "vitest";
import { anthropicMeters, meter, openaiMeters } from "./normalize";

describe("API calculator normalization", () => {
  it("keeps OpenAI cached and reasoning meters as subsets", () => {
    const meters = openaiMeters({
      prompt_tokens: 100,
      prompt_tokens_details: { cached_tokens: 40 },
      completion_tokens: 20,
      completion_tokens_details: { reasoning_tokens: 5 },
    });

    expect(meters.map((item) => [item.name, item.value])).toEqual([
      ["prompt_total", 100],
      ["cache_read", 40],
      ["completion_total", 20],
      ["reasoning", 5],
    ]);
  });

  it("keeps Anthropic input cache classes disjoint", () => {
    const meters = anthropicMeters({
      input_tokens: 10,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 30,
      output_tokens: 40,
      server_tool_use: { web_search_requests: 2 },
    });

    expect(meters.map((item) => [item.name, item.value])).toEqual([
      ["input_uncached", 10],
      ["cache_read", 20],
      ["cache_write", 30],
      ["output", 40],
      ["web_search_requests", 2],
    ]);
  });

  it("drops invalid meter values before they reach the ledger", () => {
    expect(meter("prompt_total", -1, "token")).toBeNull();
    expect(meter("prompt_total", Number.NaN, "token")).toBeNull();
    expect(meter("prompt_total", "12", "token")).toEqual({
      name: "prompt_total",
      value: 12,
      unit: "token",
      canonical: "prompt_total",
    });
  });
});
