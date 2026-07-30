import type { Attempt, Meter } from "./types";

export function meter(name: string, value: unknown, unit: Meter["unit"], canonical = name): Meter | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? { name, value: number, unit, canonical } : null;
}

/** Anthropic classes are disjoint and may be summed. */
export function anthropicMeters(usage: Record<string, unknown>): Meter[] {
  return [
    meter("input_uncached", usage.input_tokens, "token"),
    meter("cache_read", usage.cache_read_input_tokens, "token"),
    meter("cache_write", usage.cache_creation_input_tokens, "token"),
    meter("output", usage.output_tokens, "token"),
    meter("web_search_requests", (usage.server_tool_use as Record<string, unknown> | undefined)?.web_search_requests, "request"),
    meter("web_fetch_requests", (usage.server_tool_use as Record<string, unknown> | undefined)?.web_fetch_requests, "request"),
  ].filter((value): value is Meter => value !== null);
}

/** OpenAI cache/reasoning values are subsets and must not be added to totals. */
export function openaiMeters(usage: Record<string, unknown>): Meter[] {
  const promptDetails = usage.prompt_tokens_details as Record<string, unknown> | undefined;
  const completionDetails = usage.completion_tokens_details as Record<string, unknown> | undefined;
  return [
    meter("prompt_total", usage.prompt_tokens, "token"),
    meter("cache_read", promptDetails?.cached_tokens, "token"),
    meter("completion_total", usage.completion_tokens, "token"),
    meter("reasoning", completionDetails?.reasoning_tokens, "token"),
  ].filter((value): value is Meter => value !== null);
}

export function buildAttempt(input: Omit<Attempt, "meters"> & { meters: Meter[] }): Attempt {
  return { ...input, meters: input.meters.filter((item) => Number.isFinite(item.value) && item.value >= 0) };
}
