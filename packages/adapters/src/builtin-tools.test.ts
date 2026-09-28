import { describe, expect, it } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";

describe("public peer message schema", () => {
  it("offers effect descriptors only on message_bot, where the hold classifier reads them", () => {
    const message = builtinAgentTools.find((tool) => tool.name === "message_bot");
    const helper = builtinAgentTools.find((tool) => tool.name === "run_subagent");
    expect(message?.inputSchema.properties).toHaveProperty("requested_effects");
    expect(helper?.inputSchema.properties).not.toHaveProperty("requested_effects");
  });
});
