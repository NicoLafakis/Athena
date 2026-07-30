export type Provider = "openai" | "anthropic" | "gemini" | "kimi" | "leonardo" | "anysite" | string;
export type PricingStatus = "priced" | "partial" | "unpriced" | "not_billable" | "unknown";

export interface Meter {
  name: string;
  value: number;
  unit: "token" | "request" | "image" | "second" | "credit" | string;
  /** Optional VMP meter name for stable normalization. */
  canonical?: string;
}

export interface Attempt {
  external_id: string;
  logical_request_id?: string | null;
  parent_attempt_id?: string | null;
  provider: Provider;
  model: string;
  operation: string;
  started_at: string;
  duration_ms?: number | null;
  outcome: "ok" | "error" | "cancelled" | "unknown";
  credential_ref?: string | null;
  source?: string | null;
  meters: Meter[];
}

export interface CalculatorReport {
  schema_version: "v1";
  period: { days: number; start: string; end: string };
  totals: { attempts: number; cost_usd: number | null; pricing_status: PricingStatus };
  by_model: Array<{ provider: Provider; model: string; attempts: number; meters: Meter[]; cost_usd: number | null; pricing_status: PricingStatus }>;
  by_source: Array<{ source: string; attempts: number; cost_usd: number | null }>;
  attempts: Attempt[];
}

export interface LedgerStore {
  insertIfAbsent(attempt: Attempt): Promise<"inserted" | "duplicate">;
  listSince(start: Date): Promise<Attempt[]>;
}
