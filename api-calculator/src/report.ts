import type { Attempt, CalculatorReport, Meter, PricingStatus } from "./types";
import { emptyReport } from "./contract";

export interface PriceLookup { (provider: string, model: string, meter: Meter): number | null; }

export function buildReport(attempts: Attempt[], days: number, price: PriceLookup): CalculatorReport {
  const end = new Date();
  const start = new Date(end.getTime() - Math.min(365, Math.max(1, days)) * 86_400_000);
  const report = emptyReport(start, end);
  report.attempts = attempts;
  report.totals.attempts = attempts.length;
  const models = new Map<string, { provider: string; model: string; attempts: number; meters: Map<string, Meter>; cost: number | null; status: PricingStatus }>();
  const sources = new Map<string, { attempts: number; cost: number | null }>();
  let totalCost = 0;
  let unknown = false;
  for (const attempt of attempts) {
    const key = `${attempt.provider}\0${attempt.model}`;
    const group = models.get(key) ?? { provider: attempt.provider, model: attempt.model, attempts: 0, meters: new Map(), cost: 0, status: "priced" as PricingStatus };
    group.attempts++;
    let attemptCost: number | null = 0;
    for (const current of attempt.meters) {
      const existing = group.meters.get(current.name);
      group.meters.set(current.name, existing ? { ...existing, value: existing.value + current.value } : { ...current });
      const unitCost = price(attempt.provider, attempt.model, current);
      if (unitCost === null) { unknown = true; group.status = "unpriced"; group.cost = null; attemptCost = null; } else { if (attemptCost !== null) attemptCost += current.value * unitCost; if (group.cost !== null) group.cost += current.value * unitCost; }
    }
    models.set(key, group);
    const source = attempt.source ?? attempt.operation;
    const sourceGroup = sources.get(source) ?? { attempts: 0, cost: 0 };
    sourceGroup.attempts++;
    if (attemptCost === null) sourceGroup.cost = null; else if (sourceGroup.cost !== null) sourceGroup.cost += attemptCost;
    sources.set(source, sourceGroup);
  }
  for (const group of models.values()) { if (group.cost === null) unknown = true; else totalCost += group.cost; report.by_model.push({ provider: group.provider, model: group.model, attempts: group.attempts, meters: [...group.meters.values()], cost_usd: group.cost, pricing_status: group.status }); }
  report.by_source = [...sources.entries()].map(([source, value]) => ({ source, attempts: value.attempts, cost_usd: value.cost }));
  report.totals.cost_usd = unknown ? null : totalCost;
  report.totals.pricing_status = unknown ? "partial" : "priced";
  return report;
}
