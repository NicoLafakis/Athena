import { describe, expect, it } from "vitest";
import { MemoryLedgerStore } from "../adapters/memory-ledger";
import { readAttempts } from "./ledger";
import type { Attempt } from "./types";

describe("API calculator ledger adapter", () => {
  it("deduplicates attempts by external id", async () => {
    const store = new MemoryLedgerStore();
    const attempt = makeAttempt("same-id", new Date().toISOString());

    await expect(store.insertIfAbsent(attempt)).resolves.toBe("inserted");
    await expect(store.insertIfAbsent({ ...attempt, operation: "retry" })).resolves.toBe("duplicate");

    const attempts = await store.listSince(new Date(Date.now() - 86_400_000));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.operation).toBe("chat");
  });

  it("lists only attempts inside the requested window", async () => {
    const store = new MemoryLedgerStore();
    await store.insertIfAbsent(makeAttempt("old", new Date(Date.now() - 10 * 86_400_000).toISOString()));
    await store.insertIfAbsent(makeAttempt("new", new Date().toISOString()));

    const attempts = await readAttempts(store, 2);
    expect(attempts.map((attempt) => attempt.external_id)).toEqual(["new"]);
  });
});

function makeAttempt(externalId: string, startedAt: string): Attempt {
  return {
    external_id: externalId,
    provider: "openai",
    model: "gpt-test",
    operation: "chat",
    started_at: startedAt,
    outcome: "ok",
    meters: [{ name: "prompt_total", value: 1, unit: "token" }],
  };
}
