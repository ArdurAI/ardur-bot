import { RuntimeInfoSchema } from "@ardurbot/contracts";
import { expect, it } from "vitest";
import { brokerObservedRuntimeInfo } from "./hermes-compatibility.js";

it("keeps nullable Ollama effort from invalidating the entire runtime evidence", () => {
  const info = brokerObservedRuntimeInfo(null, "llama3.2:1b", undefined);
  expect(RuntimeInfoSchema.parse({ runtimeKind: "hermes", ...info })).toMatchObject({
    runtimeKind: "hermes",
    reportedModel: "llama3.2:1b",
    requestedEffort: "off",
  });
});
