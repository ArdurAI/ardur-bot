import type { RuntimePin } from "@ardurbot/contracts";
import { failureCategoryMessage, HERMES_CONTEXT_LIMIT_MESSAGE } from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import { canBotRun } from "./pin-resolution.js";

const pin: RuntimePin = {
  runtimeKind: "hermes",
  provider: "openai-compatible",
  modelId: "fixture-model",
  credentialId: "connection",
  effort: "off",
  revision: 0,
};
const model = {
  provider: "openai-compatible",
  id: "fixture-model",
  baseUrl: "https://models.example.com/v1",
  contextWindow: 65_536,
  thinkingLevel: "off" as const,
};
const params = { runtime: "Hermes", bot: "this bot" };
describe("one run settings rule", () => {
  it.each([
    {
      name: "sandbox",
      input: { placement: { computer: { kind: "docker" }, experimental: true } },
      sentence: failureCategoryMessage("computer-unsupported", params),
    },
    {
      name: "Experimental off",
      input: { placement: { computer: { kind: "desktop" }, experimental: false } },
      sentence: failureCategoryMessage("experimental-off", params),
    },
    {
      name: "disconnected model",
      input: { connection: { credential: null } },
      sentence: failureCategoryMessage("connection-missing", params),
    },
    {
      name: "local-only space",
      input: { model, spacePolicy: { mode: "local" } },
      sentence: failureCategoryMessage("destinations-space", params),
    },
    {
      name: "Hermes floor",
      input: { model: { ...model, contextWindow: 8_192 } },
      sentence: HERMES_CONTEXT_LIMIT_MESSAGE,
    },
  ])("refuses $name with the run sentence", ({ input, sentence }) => {
    expect(canBotRun({ pin, ...input })).toMatchObject({ kind: "problem", reason: sentence });
  });
  it("allows a connected local model on a host with Experimental on", () => {
    expect(
      canBotRun({
        pin,
        model: { ...model, baseUrl: "http://localhost:8080/v1" },
        connection: { credential: { id: "connection", provider: "openai-compatible" } },
        placement: { computer: { kind: "desktop" }, experimental: true },
        spacePolicy: { mode: "local" },
      }),
    ).toBeUndefined();
  });
  it.each(["", "missing", "docker"])(
    "never treats an unresolved connection %s as the host",
    (connectionId) => {
      expect(
        canBotRun({
          pin,
          placement: {
            computer: { kind: "desktop", connectionId, connectionSettings: null },
            experimental: true,
          },
        }),
      ).toMatchObject({ reasonId: "computer-unsupported" });
    },
  );
});
