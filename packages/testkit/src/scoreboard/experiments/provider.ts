import type { ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentRunRequest } from "@ardurbot/adapter-kit";
import { createStreamingRedactor, redactSecrets } from "@ardurbot/core";
import type { PrismaClient } from "@ardurbot/db";
import { PiAgentRuntime } from "../../../../adapters/src/pi-runtime.js";
import { MODEL_STREAM_MAX_RETRIES } from "../../../../adapters/src/pi-runtime-limits.js";
import type { MatrixResult } from "./catalog.js";
import type { StreamScenario } from "./schedules.js";
import {
  prefixObservation,
  RATE_SCENARIOS,
  rateSchedule,
  STREAM_SCENARIOS,
  STREAM_TEXT,
  SYNTHETIC_SECRET,
  streamSchedule,
} from "./schedules.js";

async function providerServer(
  reply: (body: Record<string, unknown>, response: ServerResponse) => Promise<void>,
) {
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += Buffer.byteLength(chunk);
        if (size > 2 * 1024 * 1024) throw new Error("Oversized synthetic request");
        chunks.push(Buffer.from(chunk));
      }
      await reply(JSON.parse(Buffer.concat(chunks).toString("utf8")), response);
    })().catch(() => response.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    close: async () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

function request(
  baseUrl: string,
  id: string,
  overrides: Partial<AgentRunRequest> = {},
): AgentRunRequest {
  return {
    botId: id,
    threadId: id,
    runId: id,
    prompt: "Return the synthetic fixture.",
    instructions: "Synthetic fixture instructions.",
    history: [],
    tools: "none",
    model: {
      provider: "openai-compatible",
      id: "matrix-v1",
      thinkingLevel: "off",
      baseUrl,
      apiKey: "local",
      contextWindow: 16000,
      maxTokens: 1024,
    },
    ...overrides,
  };
}
function event(text: string, end = false) {
  return `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "matrix-v1", choices: [{ index: 0, delta: end ? {} : { content: text }, finish_reason: end ? "stop" : null }] })}\n\n`;
}

export interface StreamWrite {
  bytes: Buffer;
  delayBeforeMs: number;
}

/**
 * Content frames, then the finish frame and [DONE].
 * short-final-delta holds the last slice and waits before that slice, the finish frame and [DONE].
 * Other scenarios keep a scheduled delay on the first slice only.
 */
export function providerStreamPlan(scenario: StreamScenario, text = STREAM_TEXT): StreamWrite[] {
  const step = scenario === "burst" ? 64 : 3;
  const chars = Array.from(text);
  const slices: string[] = [];
  for (let index = 0; index < chars.length; index += step)
    slices.push(chars.slice(index, index + step).join(""));
  const held = scenario === "short-final-delta" ? (slices.pop() ?? "") : "";
  const writes: StreamWrite[] = [];
  for (const [sliceIndex, slice] of slices.entries()) {
    for (const part of streamSchedule(scenario, event(slice))) {
      const delayBeforeMs = scenario === "short-final-delta" || sliceIndex !== 0 ? 0 : part.delayMs;
      writes.push({ bytes: Buffer.from(part.bytes), delayBeforeMs });
    }
  }
  const terminalDelayMs =
    scenario === "short-final-delta" ? (streamSchedule(scenario).at(-1)?.delayMs ?? 0) : 0;
  if (held) {
    const heldParts = streamSchedule(scenario, event(held));
    for (const [index, part] of heldParts.entries()) {
      writes.push({
        bytes: Buffer.from(part.bytes),
        delayBeforeMs: index === 0 ? terminalDelayMs : 0,
      });
    }
  }
  writes.push({
    bytes: Buffer.from(`${event("", true)}data: [DONE]\n\n`),
    delayBeforeMs: held ? 0 : terminalDelayMs,
  });
  return writes;
}

export async function streamingExperiment(prisma: PrismaClient): Promise<MatrixResult> {
  await prisma.$executeRaw`CREATE SCHEMA IF NOT EXISTS scoreboard_fixture`;
  await prisma.$executeRaw`CREATE TABLE scoreboard_fixture.safe_deltas (scenario text NOT NULL, seq integer NOT NULL, value text NOT NULL, PRIMARY KEY (scenario, seq))`;
  const samples = [];
  for (const scenario of STREAM_SCENARIOS) {
    const server = await providerServer(async (_body, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      // Split the secret across protocol events and split Unicode across network writes.
      for (const part of providerStreamPlan(scenario)) {
        if (part.delayBeforeMs) await delay(part.delayBeforeMs);
        if (!response.write(part.bytes))
          await new Promise<void>((resolve) => {
            response.once("drain", resolve);
            response.once("close", resolve);
          });
        if (response.destroyed) return;
      }
      response.end();
    });
    try {
      const redactor = createStreamingRedactor([SYNTHETIC_SECRET]);
      const expected = redactSecrets(STREAM_TEXT, [SYNTHETIC_SECRET]);
      let assembled = "";
      let completeAtMs: number | null = null;
      let seq = 0;
      const started = performance.now();
      const save = async (text: string) => {
        if (!text) return;
        if (scenario === "slow-database" || scenario === "slow-renderer") await delay(5);
        await prisma.$executeRaw`INSERT INTO scoreboard_fixture.safe_deltas (scenario, seq, value) VALUES (${scenario}, ${seq++}, ${text})`;
        assembled += text;
        if (completeAtMs === null && assembled === expected)
          completeAtMs = performance.now() - started;
      };
      for await (const item of new PiAgentRuntime().run(
        request(server.baseUrl, `stream-${scenario}`),
        { signal: AbortSignal.timeout(10000) },
      )) {
        if (item.type === "text") await save(redactor.push(item.text));
      }
      await save(redactor.finish());
      const rows = await prisma.$queryRaw<
        Array<{ value: string }>
      >`SELECT value FROM scoreboard_fixture.safe_deltas WHERE scenario = ${scenario} ORDER BY seq`;
      const text = rows.map((row) => row.value).join("");
      const requiredDelayMs = providerStreamPlan(scenario).reduce(
        (max, part) => Math.max(max, part.delayBeforeMs),
        0,
      );
      // Timers may fire slightly early. 40ms is slack under a 300ms frame, not a shorter scenario.
      const finalTextAfterDelay =
        requiredDelayMs === 0 || (completeAtMs !== null && completeAtMs + 40 >= requiredDelayMs);
      samples.push({
        scenario,
        exact: text === expected,
        secretAbsent: !text.includes(SYNTHETIC_SECRET),
        persistedBytes: Buffer.byteLength(text),
        elapsedMs: performance.now() - started,
        completeAtMs,
        requiredDelayMs,
        finalTextAfterDelay,
      });
    } finally {
      await server.close();
    }
  }
  const checks = {
    exactOrderedOutput: samples.every((row) => row.exact),
    noSecretExposure: samples.every((row) => row.secretAbsent),
    finalTextFollowsDelayedTerminal: samples.every(
      (row) => row.scenario !== "short-final-delta" || row.finalTextAfterDelay,
    ),
  };
  return {
    id: "O2",
    experiment: "O2",
    tier: "T1",
    status: Object.values(checks).every(Boolean) ? "passed" : "finding",
    checks,
    measurements: { samples, queueHighWaterBytes: null, safeTextToPaintMs: null },
    coverage: [
      "real-Pi-HTTP-SSE-parser",
      "production-streaming-redactor",
      "postgres-safe-delta-consumer",
    ],
    gaps: [
      "slow-renderer throttles this consumer only. Executor flush cadence and renderer paint are not in this process.",
      "Pi queue high-water and terminal cancellation instrumentation remain incomplete.",
    ],
  };
}

export async function prefixExperiment(): Promise<MatrixResult> {
  const requests: unknown[] = [];
  const server = await providerServer(async (body, response) => {
    requests.push(body);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`${event("Fixture.")}${event("", true)}data: [DONE]\n\n`);
  });
  const cases = [
    "unchanged-a",
    "unchanged-b",
    "time-only",
    "memory-revision",
    "grant-change",
    "tool-schema",
  ];
  try {
    for (const variant of cases) {
      const tool = {
        name: "fixture_read",
        description: "Read synthetic fixture",
        inputSchema: {
          type: "object",
          properties: { revision: { type: variant === "tool-schema" ? "string" : "integer" } },
        },
      };
      const run = request(server.baseUrl, `prefix-${variant}`, {
        instructions: `Synthetic fixture instructions. Time: ${variant === "time-only" ? "2000-01-02" : "2000-01-01"}. Memory revision: ${variant === "memory-revision" ? 2 : 1}.`,
        tools: variant === "grant-change" ? "none" : [tool],
      });
      for await (const _item of new PiAgentRuntime().run(run, {
        signal: AbortSignal.timeout(5000),
      })) {
        /* consume the ordinary serializer/parser */
      }
    }
    const observations = prefixObservation(requests);
    const checks = {
      identicalRequestStable:
        requests.length === cases.length && observations.hashes[0] === observations.hashes[1],
      changedInputsVisible: observations.hashes
        .slice(2)
        .every((hash) => hash !== observations.hashes[0]),
    };
    return {
      id: "O3",
      experiment: "O3",
      tier: "T1",
      status: Object.values(checks).every(Boolean) ? "passed" : "finding",
      checks,
      measurements: { cases, ...observations, usage: null },
      coverage: ["actual-Pi-provider-serialized-request-hashes"],
      gaps: [
        "Direct runtime probes do not certify Chief of Staff/executor prefix placement, plugin revisions, provider cache boundaries or live cache hits.",
      ],
    };
  } finally {
    await server.close();
  }
}

function retryGapMs(times: readonly number[]) {
  const sorted = [...times].sort((left, right) => left - right);
  if (sorted.length < 3) return null;
  return sorted[2]! - sorted[0]!;
}

/** Chat completions only. Prelude requests are answered so they cannot hide the measured call. */
async function completionFailureServer(
  respond: (input: { model: unknown; response: ServerResponse }) => Promise<void>,
) {
  const preludes: string[] = [];
  const server = createServer((request, response) => {
    const url = request.url ?? "";
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      let model: unknown = null;
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: unknown };
        model = parsed.model ?? null;
      } catch {
        model = null;
      }
      if (!url.includes("/chat/completions")) {
        preludes.push(`${request.method ?? "GET"} ${url}`);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ object: "list", data: [] }));
        return;
      }
      void respond({ model, response }).catch(() => {
        if (!response.writableEnded) response.destroy();
      });
    });
    request.on("error", () => {
      if (!response.writableEnded) response.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    preludes,
    close: async () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

export async function rateLimitExperiment(): Promise<MatrixResult> {
  const samples = [];
  // Long enough for one cold completion plus a one-second Retry-After, then stop.
  const deadlineMs = 8000;
  const attemptCap = 2 * (1 + MODEL_STREAM_MAX_RETRIES);
  for (const scenario of RATE_SCENARIOS) {
    const schedule = rateSchedule(scenario, 606);
    const attempts: Array<{ atMs: number; model: unknown }> = [];
    const started = performance.now();
    const server = await completionFailureServer(async ({ model, response }) => {
      attempts.push({ atMs: performance.now() - started, model });
      await delay(schedule.jitterMs[(attempts.length - 1) % schedule.jitterMs.length]!);
      if (schedule.disconnect || attempts.length > schedule.maxObservedAttempts) {
        response.destroy();
        return;
      }
      response.writeHead(schedule.status, {
        "content-type": "application/json",
        ...schedule.headers,
      });
      response.end(
        JSON.stringify({
          error: {
            message: "Synthetic provider failure",
            type: schedule.code,
            code: schedule.code,
          },
        }),
      );
    });
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), deadlineMs);
      try {
        await Promise.all(
          [0, 1].map(async (bot) => {
            try {
              for await (const _item of new PiAgentRuntime().run(
                request(server.baseUrl, `rate-${scenario}-${bot}`),
                { signal: controller.signal },
              )) {
                /* retain every wire attempt above */
              }
            } catch {
              /* cancellation/failure is an expected outcome, not discarded */
            }
          }),
        );
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
      const times = attempts.map((attempt) => attempt.atMs);
      const gap = retryGapMs(times);
      const origin = times.length ? Math.min(...times) : 0;
      samples.push({
        scenario,
        attempts,
        elapsedMs: performance.now() - started,
        seed: 606,
        preludeRequests: [...server.preludes],
        retryGapMs: gap,
        // A shared budget would allow one follow-up across both bots, not one retry each.
        retriesAfterReset: times.filter((time) => time >= origin + 800).length,
      });
    } finally {
      await server.close();
    }
  }
  const reset = samples.find((row) => row.scenario === "429-reset");
  const malformed = samples.find((row) => row.scenario === "retry-after-malformed");
  const authentication = samples.find((row) => row.scenario === "authentication-failure");
  const checks = {
    attemptsObserved: samples.every((row) => row.attempts.length > 0),
    attemptCap: samples.every((row) => row.attempts.length <= attemptCap),
    sameProviderPin: samples.every((row) =>
      row.attempts.every((attempt) => attempt.model === "matrix-v1"),
    ),
    authenticationNotRetried: authentication?.attempts.length === 2,
    retryAfterHonored: (reset?.retryGapMs ?? 0) >= 800,
    sharedAdmission: reset?.retriesAfterReset === 1,
    malformedRetryWasDeferred: (malformed?.retryGapMs ?? 0) >= 200,
  };
  return {
    id: "O8",
    experiment: "O8",
    tier: "T1",
    status: Object.values(checks).every(Boolean) ? "passed" : "finding",
    checks,
    measurements: {
      samples,
      attemptCap,
      runtimeMaxRetries: MODEL_STREAM_MAX_RETRIES,
      deadlineMs,
      runtimeRetryJitterSeeded: false,
    },
    coverage: [
      "real-Pi-HTTP-failures",
      "two-bots-one-fixture-account",
      "seeded-fault-delays",
      "bounded-abort",
    ],
    gaps: [
      "The fixture seeds fault-injection jitter; production retry jitter stays random and is not asserted.",
      "No shared account admission gate exists in the runtime retry helper. Fleet-wide reset windows remain unmeasured.",
      "A non-numeric Retry-After is not given a finite fallback delay before the runtime's single retry.",
    ],
  };
}
