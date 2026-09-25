import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
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

afterEach(() => vi.restoreAllMocks());

it.each(["runner", "counter"])(
  "refuses dispatch when synchronous %s work exhausts the deadline before the timer runs",
  async (stage) => {
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const transport = vi.fn(async () => "must not dispatch");
    const failure = await runBoundedLive({
      route,
      budget: { requests: 1, tokens: 100, milliseconds: 10 },
      counter: {
        ...counter,
        count: () => {
          if (stage === "counter") now += 10;
          return 10;
        },
      },
      transport,
      run: async (send) => {
        if (stage === "runner") now += 10;
        return send(request);
      },
    }).catch((error: unknown) => error);
    expect(transport).not.toHaveBeenCalled();
    expect(failure).toBeInstanceOf(LiveRunError);
    expect(failure).toMatchObject({
      message: "T3 time budget exhausted",
      evidence: { usedRequests: 0, reservedTokens: 0, attempts: [] },
    });
  },
);

it.each(["provider", "runner"])(
  "refuses synchronous %s completion at the deadline even if the timer has not fired",
  async (stage) => {
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    let signal: AbortSignal | undefined;
    const transport = vi.fn(async (_request: LiveRequest, abort: AbortSignal) => {
      signal = abort;
      if (stage === "provider") now += 10;
      return "late completion";
    });
    const failure = await runBoundedLive({
      route,
      budget: { requests: 1, tokens: 100, milliseconds: 10 },
      counter,
      transport,
      run: async (send) => {
        const result = await send(request);
        if (stage === "runner") now += 10;
        return result;
      },
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LiveRunError);
    expect(failure).toMatchObject({
      message: "T3 time budget exhausted",
      evidence: {
        usedRequests: 1,
        reservedTokens: 20,
        attempts: [{ outcome: stage === "provider" ? "cancelled" : "completed" }],
      },
    });
    expect(signal?.aborted).toBe(true);
  },
);

it("accepts completion strictly before the monotonic deadline", async () => {
  let now = 100;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const result = await runBoundedLive({
    route,
    budget: { requests: 1, tokens: 100, milliseconds: 10 },
    counter,
    transport: async () => {
      now += 9;
      return "within budget";
    },
    run: (send) => send(request),
  });
  expect(result.result).toBe("within budget");
  expect(result.attempts).toMatchObject([{ outcome: "completed" }]);
});

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
