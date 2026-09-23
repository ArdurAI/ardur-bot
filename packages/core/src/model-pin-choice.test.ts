import { expect, it } from "vitest";
import {
  modelPinOptionKey,
  parseModelPinOptionKey,
  spaceDefaultEffort,
} from "./model-pin-choice.js";

it("retains the displayed inherited effort when a model does not support medium", () => {
  expect(spaceDefaultEffort(true, ["off", "high"])).toBe("high");
  expect(spaceDefaultEffort(true, ["low", "medium", "high"])).toBe("medium");
  expect(spaceDefaultEffort(true, ["low"])).toBe("low");
  expect(spaceDefaultEffort(false, ["off"])).toBe("off");
});

it("distinguishes two custom connections advertising the same model", () => {
  const first = modelPinOptionKey("openai-compatible", "same::model", "first");
  const second = modelPinOptionKey("openai-compatible", "same::model", "second");
  expect(first).not.toBe(second);
  expect(parseModelPinOptionKey(first)).toEqual({
    provider: "openai-compatible",
    modelId: "same::model",
    credentialId: "first",
  });
  expect(parseModelPinOptionKey(second)?.credentialId).toBe("second");
  expect(parseModelPinOptionKey("xai::grok")).toEqual({ provider: "xai", modelId: "grok" });
  expect(parseModelPinOptionKey("[broken")).toBeNull();
  expect(parseModelPinOptionKey('["xai", "grok", 1]')).toBeNull();
});
