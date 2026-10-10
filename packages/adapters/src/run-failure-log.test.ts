import { RuntimePinError, runtimePinProblem } from "@ardurbot/contracts/runtime-pins";
import { createLogger, createTestSink, installLogger } from "@ardurbot/logging";
import { afterEach, expect, it, vi } from "vitest";
import { logRunFailure } from "./run-failure-log.js";

afterEach(() => {
  vi.unstubAllEnvs();
  installLogger(createLogger({ service: "fixture", sinks: [] }));
});

it("does not serialize content-bearing failure causes into debug logs by default", () => {
  vi.stubEnv("ARDUR_DETAILED_PROCESS_LOGS", undefined);
  const sink = createTestSink();
  installLogger(createLogger({ service: "fixture", level: "debug", sinks: [sink] }));
  const secret = "made-up-opaque-credential";
  const error = new Error(`Imaginary prompt sentence ${secret}`, {
    cause: new Error(`Imaginary file line ${secret}`, { cause: { tail: secret } }),
  });
  logRunFailure("Run failed", error, [], { runId: "fixture", providerErrorKind: "unknown" });
  expect(sink.events).toHaveLength(1);
  expect(sink.events[0]).toMatchObject({
    level: "error",
    runId: "fixture",
    providerErrorKind: "unknown",
  });
  expect(JSON.stringify(sink.events)).not.toMatch(
    /Imaginary prompt|Imaginary file|made-up-opaque|tail/,
  );
});

it("records bounded runtime failure facts after redacting current run secrets", () => {
  const sink = createTestSink();
  installLogger(createLogger({ service: "fixture", level: "info", sinks: [sink] }));
  const problem = runtimePinProblem(
    {
      runtimeKind: "codex-app-server",
      provider: "openai-codex",
      modelId: "fixture-model",
      effort: "high",
      credentialId: null,
      revision: 1,
    },
    "runtime-unavailable",
    "The runtime stopped.",
    "runtime-stopped",
  );
  problem.failure = {
    step: "stream",
    errorClass: "CodexTransportError",
    message: "transport closed with fixture-opaque-credential",
    exitCode: 17,
    signal: null,
    retryable: true,
    retries: 3,
  };
  logRunFailure("Run failed", new RuntimePinError(problem), ["fixture-opaque-credential"], {
    runId: "fixture",
  });
  expect(sink.events).toHaveLength(1);
  expect(sink.events[0]).toMatchObject({
    level: "error",
    runtimeFailure: {
      step: "stream",
      exitCode: 17,
      retries: 3,
    },
    error: { name: "CodexTransportError", message: "transport closed with [redacted]" },
  });
  expect(JSON.stringify(sink.events)).not.toContain("fixture-opaque-credential");
});
