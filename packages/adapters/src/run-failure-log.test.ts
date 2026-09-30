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
