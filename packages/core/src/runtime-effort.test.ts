import { describe, expect, it } from "vitest";
import { botEffortLabel, runtimeEffortLabel } from "./runtime-effort.js";

const bot = {
  runtimeKind: "claude-code" as const,
  modelProvider: "anthropic",
  modelId: "claude-opus-5",
  thinkingLevel: "high" as const,
  modelCredentialId: "native:claude-code",
  modelPinRevision: 3,
};
const pin = {
  runtimeKind: bot.runtimeKind,
  provider: bot.modelProvider,
  modelId: bot.modelId,
  effort: bot.thinkingLevel,
  credentialId: bot.modelCredentialId,
  revision: bot.modelPinRevision,
};
describe("effort evidence labels", () => {
  it.each([undefined, false, true])("labels Claude evidence %s consistently", (effortAttested) => {
    expect(runtimeEffortLabel(pin, { effortAttested }, "requested")).toBe(
      effortAttested ? "high" : "high · requested",
    );
  });
  it("preserves legacy labels on other runtimes and never invents an effort", () => {
    expect(runtimeEffortLabel({ ...pin, runtimeKind: "pi" }, null, "requested")).toBe("high");
    expect(
      runtimeEffortLabel({ ...pin, effort: null }, { effortAttested: false }, "requested"),
    ).toBeNull();
    expect(runtimeEffortLabel(pin, { effortAttested: false }, "已请求")).toBe("high · 已请求");
  });
  it("uses evidence only for the complete current pin", () => {
    const runtimeInfo = { runtimeKind: bot.runtimeKind, effortAttested: true };
    expect(botEffortLabel(bot, { runtimePin: pin, runtimeInfo }, "requested")).toBe("high");
    for (const change of [
      { runtimeKind: "pi" as const },
      { provider: "other" },
      { modelId: "other" },
      { effort: "low" },
      { credentialId: "other" },
      { revision: 2 },
    ]) {
      expect(
        botEffortLabel(bot, { runtimePin: { ...pin, ...change }, runtimeInfo }, "requested"),
      ).toBe("high · requested");
    }
    expect(botEffortLabel(bot, null, "requested")).toBe("high · requested");
    expect(
      botEffortLabel(
        bot,
        { runtimePin: pin, runtimeInfo: { ...runtimeInfo, runtimeKind: "pi" } },
        "requested",
      ),
    ).toBe("high · requested");
  });
});
