import { describe, expect, it } from "vitest";
import { defaultOllamaUrl, ollamaThink } from "./ollama.js";

describe("Ollama defaults and effort", () => {
  it("uses loopback in source deployments and the host gateway in packaged deployments", () => {
    expect(defaultOllamaUrl("source")).toBe("http://127.0.0.1:11434");
    expect(defaultOllamaUrl("packaged")).toBe("http://host.docker.internal:11434");
  });
  it.each(["low", "medium", "high"])("maps %s to on without inventing levels", (effort) => {
    expect(ollamaThink(effort, { reasoning: true, supportsThinkingOff: true })).toBe(true);
  });
  it("maps none to off and requires null for not applicable", () => {
    expect(ollamaThink("none", { reasoning: true, supportsThinkingOff: true })).toBe(false);
    expect(ollamaThink(null, { reasoning: false, supportsThinkingOff: true })).toBeUndefined();
    expect(() => ollamaThink("high", { reasoning: false, supportsThinkingOff: true })).toThrow(
      "not applicable",
    );
  });
});
