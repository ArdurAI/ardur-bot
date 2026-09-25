import { SpaceLearningConfigSchema } from "@ardurbot/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ rpc: request }));

import {
  loadCapabilitySettings,
  proposeMemoryChange,
  saveCapabilitySettings,
  setComputerNetwork,
  setMemoryGeneration,
} from "./capability-settings.js";

beforeEach(() => request.mockReset());
describe("native capability and memory controls", () => {
  it("roundtrips server settings and waits for native confirmation before sending egress", async () => {
    request.mockResolvedValueOnce({
      settings: {},
      canConfigure: false,
      computers: [],
      unsupportedRuntimes: [],
    });
    expect((await loadCapabilitySettings()).settings.connectorSearch).toBe(false);
    request.mockClear();
    await expect(
      setComputerNetwork({ computerId: "computer", networkEgress: false, confirmed: false }),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    await setComputerNetwork({ computerId: "computer", networkEgress: false, confirmed: true });
    expect(request).toHaveBeenCalledWith("capabilities/network", {
      computerId: "computer",
      networkEgress: false,
      confirmed: true,
    });
  });
  it("uses consent configuration without creating an automatic grant", async () => {
    const settings = SpaceLearningConfigSchema.parse({
      canConfigure: true,
      destination: {
        runtimeKind: "pi",
        provider: null,
        modelId: null,
        effort: null,
        credentialId: null,
        revision: 0,
      },
    });
    request.mockResolvedValueOnce({ ...settings, enabled: true });
    await setMemoryGeneration(settings, true);
    expect(request).toHaveBeenCalledWith("learning/configure", {
      enabled: true,
      budgets: settings.budgets,
      consolidationEnabled: false,
      reviewerPin: settings.destination,
    });
    request.mockClear();
    await expect(setMemoryGeneration({ ...settings, canConfigure: false }, true)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it("only submits proposal intent and rejects settings outside the shared contract", async () => {
    request.mockResolvedValueOnce([]);
    await proposeMemoryChange({
      intent: "import",
      text: "Profile\n- Studies plants.",
      requestId: "native-fixture",
    });
    expect(request.mock.calls.map(([path]) => path)).toEqual(["memory/propose"]);
    await expect(saveCapabilitySettings({ connectionId: "engine" } as never)).rejects.toThrow();
  });
});
