import type { Meter } from "./types";

export interface PriceRecord {
  provider: string;
  model_pattern: string;
  meter: string;
  usd_per_unit: number | null;
  effective_from: string;
  source_url: string;
  version: string;
}

/** The producer does not own authoritative prices; VMP supplies this table. */
export function createPriceLookup(records: PriceRecord[]) {
  return (provider: string, model: string, current: Meter): number | null => {
    const match = records.find((record) => record.provider === provider && record.meter === (current.canonical ?? current.name) && modelMatches(record.model_pattern, model));
    return match?.usd_per_unit ?? null;
  };
}

function modelMatches(pattern: string, model: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return model.startsWith(pattern.slice(0, -1));
  return pattern === model;
}
