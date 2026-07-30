import type { Attempt, LedgerStore } from "./types";
import { validateAttempt } from "./contract";

/** Fire-and-forget helper: telemetry must never affect the provider request. */
export function recordAttempt(store: LedgerStore, input: unknown): void {
  try {
    const attempt = validateAttempt(input);
    void store.insertIfAbsent(attempt).catch(() => undefined);
  } catch {
    // Invalid telemetry is intentionally dropped; the business request already succeeded/failed.
  }
}

export async function readAttempts(store: LedgerStore, days: number): Promise<Attempt[]> {
  const boundedDays = Math.min(365, Math.max(1, Math.floor(days || 30)));
  return store.listSince(new Date(Date.now() - boundedDays * 86_400_000));
}
