import type { Attempt, CalculatorReport, Meter } from "./types";

export const CALCULATOR_SCHEMA_VERSION = "v1" as const;

export function emptyReport(start: Date, end = new Date()): CalculatorReport {
  return {
    schema_version: CALCULATOR_SCHEMA_VERSION,
    period: { days: Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 86_400_000)), start: start.toISOString(), end: end.toISOString() },
    totals: { attempts: 0, cost_usd: 0, pricing_status: "priced" },
    by_model: [],
    by_source: [],
    attempts: [],
  };
}

export function validateAttempt(input: unknown): Attempt {
  if (!input || typeof input !== "object") throw new Error("attempt must be an object");
  const value = input as Partial<Attempt>;
  if (!value.external_id || !value.provider || !value.model || !value.operation || !value.started_at) throw new Error("attempt identity is incomplete");
  if (!Array.isArray(value.meters)) throw new Error("attempt meters are required");
  const meters: Meter[] = value.meters.map((meter) => {
    if (!meter || typeof meter !== "object" || typeof meter.name !== "string" || !Number.isFinite(meter.value) || typeof meter.unit !== "string") throw new Error("invalid meter");
    return { name: meter.name, value: Math.max(0, meter.value), unit: meter.unit, canonical: meter.canonical };
  });
  return { ...value, external_id: value.external_id, provider: value.provider, model: value.model, operation: value.operation, started_at: value.started_at, outcome: value.outcome ?? "unknown", meters } as Attempt;
}
