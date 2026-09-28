import { describe, it, expect } from "vitest";
import { availableProviderModels, unavailableSubscriptionModel, connectedModelOptions } from "./model-options.js";

describe("model-options", () => {
  it("availableProviderModels filters models", () => {
    const catalog = [
      { provider: "p1", id: "m1", tier: "free", sunset: null },
      { provider: "p1", id: "m2", tier: "unsupported", sunset: null },
      { provider: "p1", id: "m3", tier: "free", sunset: new Date(Date.now() - 10000).toISOString() },
      { provider: "p2", id: "m4", tier: "free", sunset: null },
    ] as any;
    
    expect(availableProviderModels(catalog, "p1", false).map(m => m.id)).toEqual(["m1"]);
    expect(availableProviderModels(catalog, "p1", true).map(m => m.id)).toEqual(["m1", "m2"]);
  });

  it("unavailableSubscriptionModel checks tier", () => {
    const catalog = [
      { provider: "p1", id: "m1", tier: "unsupported" },
      { provider: "p1", id: "m2", tier: "free" },
    ] as any;
    expect(unavailableSubscriptionModel(catalog, "p1", "m1")).toBe(true);
    expect(unavailableSubscriptionModel(catalog, "p1", "m2")).toBe(false);
  });

  it("connectedModelOptions groups and sorts", () => {
    const catalog = [
      { provider: "p1", id: "m1", tier: "free", sunset: null, placeholder: false, label: "M1" },
      { provider: "ollama", id: "m2", tier: "free", sunset: null, placeholder: false, label: "M2" },
    ] as any;
    const credentials = [
      { id: "c1", provider: "p1", label: "P1", modelId: null },
      { id: "c2", provider: "ollama", label: "Ollama", modelId: null },
    ] as any;
    
    const options = connectedModelOptions(catalog, credentials);
    expect(options[0].provider).toBe("p1");
    expect(options[1].provider).toBe("ollama");
  });
});
