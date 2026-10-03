import { RequestUsageCollector } from "@ardurbot/adapter-kit";
import { DELEGATION_LIMITS } from "@ardurbot/contracts";
import { expect, it } from "vitest";
import { brokerLedgerFixture } from "./hermes-run-budget-ledger.fixture.js";

const runAllowance = 16 * (1_000_000 + 65_536);
const reservation = 121_891;
const request = (
  patch: { reservedTokens?: number; maxRequests?: number; maxReservedTokens?: number } = {},
) =>
  new RequestUsageCollector({
    provider: "openai-compatible",
    model: "glm-5.3",
    purpose: "main",
    inputSemantics: "total-with-cache-subsets",
    mappingVersion: "fixture-v1",
    admission: {
      kind: "worker-provider-broker",
      reservedTokens: reservation,
      maxRequests: 16,
      maxReservedTokens: runAllowance,
      ...patch,
    },
  });

it.each([
  { used: 14_128, members: [36_864, 36_864, 36_864] },
  { used: 100_000, members: [36_864] },
  { used: 2_000_000, members: [36_864] },
])(
  "keeps the coordinator allowance after a production room ask resizes its root: %j",
  async ({ used, members }) => {
    const f = brokerLedgerFixture({ used });
    const first = request();
    await f.record(first.start());
    await f.record(first.snapshot({ input: 14_000, output: 128 }));
    await f.record(first.finish("success"));
    expect(f.root.reservedTokens).toBe(0);
    const resized = await f.ask(members);
    expect(resized.tokenLimit).toBeGreaterThan(DELEGATION_LIMITS.tokens);
    const storedLimit = f.root.tokenLimit;
    await f.record(request().start());
    expect(f.rows.size).toBe(2);
    expect(f.root.tokenLimit).toBe(storedLimit);
    expect(f.root.reservedTokens).toBe(reservation);
  },
);

// These call the ledger directly, so a broker-local or fixture check cannot mask a regression.
it("enforces the durable request count independently of the token allowance", async () => {
  const f = brokerLedgerFixture();
  await f.record(request({ maxRequests: 1, reservedTokens: 100 }).start());
  await expect(f.record(request({ maxRequests: 1, reservedTokens: 100 }).start())).rejects.toThrow(
    "Broker request allowance exhausted",
  );
  expect(f.rows.size).toBe(1);
});

it("enforces cumulative reservations independently of the request count", async () => {
  const f = brokerLedgerFixture();
  const admission = { reservedTokens: 100, maxRequests: 16, maxReservedTokens: 150 };
  await f.record(request(admission).start());
  await expect(f.record(request(admission).start())).rejects.toThrow(
    "Broker request allowance exhausted",
  );
  expect(f.rows.size).toBe(1);
});

it.each([{ maxRequests: 17 }, { maxReservedTokens: runAllowance + 1 }])(
  "refuses changes to the durable run allowance: %j",
  async (patch) => {
    const f = brokerLedgerFixture();
    await f.record(request({ reservedTokens: 100 }).start());
    await expect(f.record(request({ ...patch, reservedTokens: 100 }).start())).rejects.toThrow(
      "Broker request allowance exhausted",
    );
    expect(f.rows.size).toBe(1);
  },
);

it("keeps a goal at its explicit limit even when it equals the default", async () => {
  const f = brokerLedgerFixture({ goal: true });
  await expect(f.record(request().start())).rejects.toThrow("Broker root task allowance exhausted");
  expect(f.rows.size).toBe(0);
});

it("keeps a delegated worker within its attempt allowance", async () => {
  const f = brokerLedgerFixture({ delegated: true });
  await expect(f.record(request().start())).rejects.toThrow(
    "Broker delegation allowance exhausted",
  );
  expect(f.rows.size).toBe(0);
  await f.record(request({ reservedTokens: 10_000 }).start());
  expect(f.rows.size).toBe(1);
});

it.each(["cancelled", "expired"])(
  "refuses admission when the root is %s before writing a receipt",
  async (state) => {
    const f = brokerLedgerFixture();
    if (state === "cancelled") f.root.cancelRequestedAt = new Date();
    else f.root.deadlineAt = new Date(0);
    await expect(f.record(request().start())).rejects.toThrow(
      "Broker root task allowance exhausted",
    );
    expect(f.rows.size).toBe(0);
  },
);

it("bounds the coordinator's measured root spend by the effective allowance", async () => {
  const f = brokerLedgerFixture({ used: runAllowance });
  await expect(f.record(request().start())).rejects.toThrow("Broker root task allowance exhausted");
  expect(f.rows.size).toBe(0);
});

it("does not shrink a stored non-goal root limit larger than the run allowance", async () => {
  const f = brokerLedgerFixture({ used: runAllowance });
  f.root.tokenLimit = runAllowance + reservation;
  await f.record(request().start());
  expect(f.rows.size).toBe(1);
});
