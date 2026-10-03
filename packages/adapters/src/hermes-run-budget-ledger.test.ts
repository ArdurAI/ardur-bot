import { RequestUsageCollector } from "@ardurbot/adapter-kit";
import { DELEGATION_LIMITS } from "@ardurbot/contracts";
import { expect, it } from "vitest";
import { brokerLedgerFixture } from "./hermes-run-budget-ledger.fixture.js";

const runAllowance = 16 * (1_000_000 + 65_536);
const reservation = 121_891;
const request = () =>
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
