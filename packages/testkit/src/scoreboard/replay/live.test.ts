import { expect, it, vi } from "vitest";
import type { LiveRequest, LiveRoute } from "./live.js";
import { LiveRunError, runBoundedLive } from "./live.js";

const route: LiveRoute = {
  runtime: "fixture",
  provider: "fixture",
  model: "fixture",
  effort: null,
  computer: "fixture",
};
const request: LiveRequest = { route, input: "fixture", maxOutputTokens: 10 };
const counter = {
  exact: true as const,
  version: "test-only-exact-counter",
  routeKey: JSON.stringify(route),
  count: () => 10,
};

it("requires an explicit validated route counter and positive hard budgets before any call", async () => {
  const transport = vi.fn(async () => "unused");
  await expect(
    runBoundedLive({
      route,
      budget: { requests: 0, tokens: 100, milliseconds: 1000 },
      counter,
      transport,
      run: async (send) => send(request),
    }),
  ).rejects.toThrow();
  await expect(
    runBoundedLive({
      route,
      budget: { requests: 1, tokens: 100, milliseconds: 1000 },
      counter: { ...counter, routeKey: "wrong" },
      transport,
      run: async (send) => send(request),
    }),
  ).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
});

it("reserves concurrent requests before dispatch and does not refund failed attempts", async () => {
  const transport = vi.fn(async () => {
    throw new Error("provider failure");
  });
  const result = await runBoundedLive({
    route,
    budget: { requests: 5, tokens: 30, milliseconds: 1000 },
    counter,
    transport,
    run: async (send) => Promise.allSettled([send(request), send(request), send(request)]),
  });
  expect(transport).toHaveBeenCalledTimes(1);
  expect(result.reservedTokens).toBe(20);
  expect(result.attempts[0]!.outcome).toBe("failed");
  expect(result.liveAgentSuccess).toBeNull();
});

it("refuses model substitution and terminates a quiet provider at the time cap", async () => {
  const transport = vi.fn(
    async (_request: LiveRequest, signal: AbortSignal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
      ),
  );
  await expect(
    runBoundedLive({
      route,
      budget: { requests: 1, tokens: 100, milliseconds: 20 },
      counter,
      transport,
      run: async (send) => send({ ...request, route: { ...route, model: "other" } }),
    }),
  ).rejects.toThrow("substitution");
  expect(transport).not.toHaveBeenCalled();
  await expect(
    runBoundedLive({
      route,
      budget: { requests: 1, tokens: 100, milliseconds: 20 },
      counter,
      transport,
      run: async (send) => send(request),
    }),
  ).rejects.toThrow("time budget");
});

it("retains failed attempts even when the overall live runner rejects", async () => {
  const error = await runBoundedLive({
    route,
    budget: { requests: 1, tokens: 100, milliseconds: 1000 },
    counter,
    transport: async () => {
      throw new Error("synthetic provider failure");
    },
    run: (send) => send(request),
  }).catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(LiveRunError);
  expect((error as LiveRunError).evidence).toMatchObject({
    usedRequests: 1,
    reservedTokens: 20,
    attempts: [{ outcome: "failed" }],
  });
});
