import { ProductEventSchema, RuntimeInfoSchema } from "@ardurbot/contracts";
import { expect, it } from "vitest";
import { brokerObservedRuntimeInfo } from "./hermes-compatibility.js";
import { summaryOperationHash, summaryOperationManifest } from "./hermes-provider-broker.js";

it("keeps nullable Ollama effort from invalidating the entire runtime evidence", () => {
  const info = brokerObservedRuntimeInfo(null, "llama3.2:1b", undefined);
  expect(RuntimeInfoSchema.parse({ runtimeKind: "hermes", ...info })).toMatchObject({
    runtimeKind: "hermes",
    reportedModel: "llama3.2:1b",
    requestedEffort: "off",
  });
});

it("gives a summary its own bounded hash linked to the immutable source", () => {
  const pin = {
    runtimeKind: "hermes" as const,
    provider: "openai-compatible",
    modelId: "fixture",
    effort: "off",
    credentialId: "connection",
    revision: 2,
    effectiveRuntimeConfigHash: "a".repeat(64),
  };
  const manifest = summaryOperationManifest(pin, 4096);
  const hash = summaryOperationHash(manifest);
  expect(hash).toMatch(/^[a-f0-9]{64}$/);
  expect(hash).not.toBe(pin.effectiveRuntimeConfigHash);
  expect(summaryOperationHash(summaryOperationManifest(pin, 8192))).not.toBe(hash);
  expect(
    ProductEventSchema.parse({
      id: "event",
      spaceId: "space",
      threadId: "thread",
      botId: "bot",
      seq: 1,
      type: "run.configurationApplied",
      runId: "run",
      createdAt: new Date(0).toISOString(),
      payload: { operationId: "operation", sourceRunId: "run", manifest, hash },
    }).payload,
  ).toMatchObject({ hash });
  expect(() =>
    summaryOperationManifest({ ...pin, effectiveRuntimeConfigHash: undefined }, 4096),
  ).toThrow();
});
