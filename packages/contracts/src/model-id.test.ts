import { describe, expect, it } from "vitest";
import {
  MODEL_ID_MAX_LENGTH,
  ModelConnectInputSchema,
  SetGroupMemberModelPinInput,
  UpdateBotInput,
} from "./domain.js";
import { appContract } from "./rpc.js";

const inputs = [
  {
    name: "connect",
    parse: (modelId: string) =>
      ModelConnectInputSchema.safeParse({ provider: "fixture", apiKey: "fake-key", modelId }),
  },
  ...(["setDefault", "beginOAuth"] as const).map((name) => ({
    name,
    parse: (modelId: string) =>
      appContract.models[name]["~orpc"].inputSchema!.safeParse({ provider: "fixture", modelId }),
  })),
  {
    name: "bot pin",
    parse: (modelId: string) =>
      UpdateBotInput.safeParse({ botId: "bot", modelProvider: "fixture", modelId }),
  },
  {
    name: "group pin",
    parse: (modelId: string) =>
      SetGroupMemberModelPinInput.safeParse({
        groupId: "group",
        botId: "bot",
        memberId: "member",
        expectedRevision: 0,
        pin: { runtimeKind: "pi", provider: "fixture", modelId, effort: null, credentialId: "key" },
      }),
  },
];

describe.each(inputs)("$name model id", ({ parse }) => {
  it.each(["vendor/custom-model:latest", "模型/自定义", "m".repeat(MODEL_ID_MAX_LENGTH)])(
    "accepts a normal custom id within the limit",
    (modelId) => expect(parse(modelId).success).toBe(true),
  );

  it.each([
    { name: "over-long", modelId: "m".repeat(MODEL_ID_MAX_LENGTH + 1) },
    { name: "NUL", modelId: "vendor/\u0000model" },
    { name: "tab", modelId: "vendor/\tmodel" },
    { name: "line break", modelId: "vendor/\nmodel" },
    { name: "leading line break", modelId: "\nmodel" },
    { name: "trailing carriage return", modelId: "model\r" },
    { name: "delete", modelId: "vendor/\u007fmodel" },
    { name: "C1 control", modelId: "vendor/\u0085model" },
  ])("refuses $name ids with the friendly refusal", ({ modelId }) => {
    const result = parse(modelId);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ message: "Choose a model." }),
      );
    }
  });
});
