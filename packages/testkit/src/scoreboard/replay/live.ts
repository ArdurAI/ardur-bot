import type { Json } from "../tasks/catalog.js";

export interface LiveRoute {
  runtime: string;
  provider: string;
  model: string;
  effort: string | null;
  computer: string;
}
export interface LiveBudget {
  requests: number;
  tokens: number;
  milliseconds: number;
}
export interface LiveRequest {
  route: LiveRoute;
  input: Json;
  maxOutputTokens: number;
}

interface LiveAttempt {
  request: number;
  inputTokens: number;
  outputReservation: number;
  outcome: string;
}

export class LiveRunError extends Error {
  constructor(
    message: string,
    readonly evidence: { attempts: LiveAttempt[]; usedRequests: number; reservedTokens: number },
  ) {
    super(message);
    this.name = "LiveRunError";
  }
}

/**
 * Explicit T3 transport boundary. The route's validated counter and bounded output are required;
 * estimates and retrospective usage cannot enforce a hard pre-dispatch budget.
 */
export async function runBoundedLive<T>(options: {
  route: LiveRoute;
  budget: LiveBudget;
  counter: {
    exact: true;
    version: string;
    routeKey: string;
    count: (request: LiveRequest) => number;
  };
  transport: (request: LiveRequest, signal: AbortSignal) => Promise<T>;
  run: (send: (request: LiveRequest) => Promise<T>, signal: AbortSignal) => Promise<unknown>;
}) {
  const routeKey = JSON.stringify(options.route);
  for (const value of Object.values(options.budget))
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error("T3 budgets must be explicit positive integers");
  if (
    options.counter.exact !== true ||
    !options.counter.version ||
    options.counter.routeKey !== routeKey
  )
    throw new Error("T3 requires a validated exact counter for the selected route");
  if (
    !options.route.runtime ||
    !options.route.provider ||
    !options.route.model ||
    !options.route.computer
  )
    throw new Error("T3 route must be fully pinned");
  const controller = new AbortController();
  let usedRequests = 0;
  let reservedTokens = 0;
  let finished = false;
  const attempts: LiveAttempt[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("T3 time budget exhausted"));
    }, options.budget.milliseconds);
  });
  try {
    const result = await Promise.race([
      options.run(async (request) => {
        if (finished || controller.signal.aborted) throw new Error("T3 run is closed");
        if (JSON.stringify(request.route) !== routeKey)
          throw new Error("T3 route substitution refused");
        const inputTokens = options.counter.count(request);
        if (
          !Number.isSafeInteger(inputTokens) ||
          inputTokens < 0 ||
          !Number.isSafeInteger(request.maxOutputTokens) ||
          request.maxOutputTokens <= 0
        )
          throw new Error("Invalid T3 token reservation");
        const reserve = inputTokens + request.maxOutputTokens;
        if (
          usedRequests + 1 > options.budget.requests ||
          reservedTokens + reserve > options.budget.tokens
        )
          throw new Error("T3 request or token budget exhausted");
        // Reserve synchronously. Concurrent calls and failed attempts cannot overspend or refund tokens.
        usedRequests++;
        reservedTokens += reserve;
        const attempt = {
          request: usedRequests,
          inputTokens,
          outputReservation: request.maxOutputTokens,
          outcome: "started",
        };
        attempts.push(attempt);
        try {
          const value = await options.transport(request, controller.signal);
          attempt.outcome = "completed";
          return value;
        } catch (error) {
          attempt.outcome = controller.signal.aborted ? "cancelled" : "failed";
          throw error;
        }
      }, controller.signal),
      timeout,
    ]);
    if (attempts.some((attempt) => attempt.outcome === "started"))
      throw new Error("T3 runner returned with outstanding provider requests");
    return {
      result,
      attempts,
      usedRequests,
      reservedTokens,
      liveAgentSuccess: null,
      pricedCost: null,
      subscriptionQuota: null,
      humanReviewMinutes: null,
    };
  } catch (error) {
    controller.abort();
    throw new LiveRunError(error instanceof Error ? error.message : "T3 run failed", {
      attempts: attempts.map((attempt) => ({
        ...attempt,
        outcome: attempt.outcome === "started" ? "cancelled" : attempt.outcome,
      })),
      usedRequests,
      reservedTokens,
    });
  } finally {
    finished = true;
    clearTimeout(timer);
    controller.abort();
  }
}
