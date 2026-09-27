import { describe, expect, it } from "vitest";
import { antigravityEffortForModel, validateAntigravityPin } from "./antigravity-pin.js";

const models = [
  { id: "gemini-3.8-flash-low", label: "Low", efforts: ["low"] },
  { id: "claude-sonnet-4-6", label: "No effort", efforts: [] },
];
const pin = {
  runtimeKind: "antigravity" as const,
  provider: "antigravity",
  modelId: models[0]!.id,
  effort: "low",
  credentialId: "native:antigravity",
  revision: 1,
};
describe("Antigravity pin", () => {
  it("derives suffix effort and preserves no-effort null", () => {
    expect(antigravityEffortForModel(pin.modelId)).toBe("low");
    expect(validateAntigravityPin(pin, models)).toBeUndefined();
    expect(validateAntigravityPin({ ...pin, effort: null }, models)).toBeUndefined();
    expect(
      validateAntigravityPin({ ...pin, modelId: "claude-sonnet-4-6", effort: null }, models),
    ).toBeUndefined();
  });
  it("refuses mismatches and unknown model ids", () => {
    expect(validateAntigravityPin({ ...pin, effort: "high" }, models)?.code).toBe(
      "pin-effort-unsupported",
    );
    expect(validateAntigravityPin({ ...pin, modelId: "other" }, models)?.code).toBe(
      "pin-model-unknown",
    );
    expect(validateAntigravityPin({ ...pin, modelId: "claude-sonnet-4-6" }, models)?.code).toBe(
      "pin-effort-unsupported",
    );
  });
});
