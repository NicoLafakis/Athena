import type { Attempt, LedgerStore } from "../src/types";

export class MemoryLedgerStore implements LedgerStore {
  private readonly attempts = new Map<string, Attempt>();

  async insertIfAbsent(attempt: Attempt): Promise<"inserted" | "duplicate"> {
    if (this.attempts.has(attempt.external_id)) return "duplicate";
    this.attempts.set(attempt.external_id, cloneAttempt(attempt));
    return "inserted";
  }

  async listSince(start: Date): Promise<Attempt[]> {
    return [...this.attempts.values()]
      .filter((attempt) => new Date(attempt.started_at).getTime() >= start.getTime())
      .map(cloneAttempt);
  }
}

function cloneAttempt(attempt: Attempt): Attempt {
  return { ...attempt, meters: attempt.meters.map((meter) => ({ ...meter })) };
}
