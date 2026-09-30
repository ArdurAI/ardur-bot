import type { PrismaClient } from "@ardurbot/db";
import { expect, it, vi } from "vitest";
import {
  destinationForModel,
  enforceDelegationDestination,
  modelLocalityRefusedBy,
} from "./model-locality.js";

it("uses endpoint metadata and does not treat a missing destination as local", () => {
  expect(destinationForModel({ provider: "unknown", id: "unknown" })).toEqual({
    host: null,
    local: false,
  });
  expect(
    destinationForModel({
      provider: "openai-compatible",
      id: "fixture",
      baseUrl: "http://localhost:8080/v1",
    }),
  ).toEqual({ host: "localhost", local: true });
});
it("refuses an endpoint edit after admission and a tightened requester policy", async () => {
  const row = {
    requesterBotId: "chief",
    reservedTokens: 100,
    usedTokens: 20,
    spaceId: "space",
    userId: "owner",
    snapshot: {
      pin: {
        provider: "openai-compatible",
        modelId: "fixture",
        effort: "off",
        credentialId: "connection",
        revision: 1,
      },
      computer: { id: "computer", mode: "team", kind: "test" },
      destination: { host: "model.example.test", local: false },
    },
  };
  const bot = { allowedModelDestinations: { mode: "any" } };
  const prisma = {
    delegation: { findUniqueOrThrow: vi.fn(async () => row) },
    bot: { findFirstOrThrow: vi.fn(async () => bot) },
  } as unknown as PrismaClient;
  const model = {
    provider: "openai-compatible",
    id: "fixture",
    baseUrl: "https://model.example.test/v1",
  };
  await expect(enforceDelegationDestination(prisma, "handoff", model)).resolves.toBe(80);
  await expect(
    enforceDelegationDestination(prisma, "handoff", {
      ...model,
      baseUrl: "https://other.example.test/v1",
    }),
  ).rejects.toMatchObject({ problem: { code: "locality-denied" } });
  bot.allowedModelDestinations = { mode: "local" };
  await expect(enforceDelegationDestination(prisma, "handoff", model)).rejects.toMatchObject({
    problem: { code: "locality-denied" },
  });
});

it("names the policy that refused the model, checking the bot's first", () => {
  const remote = { provider: "xai", id: "grok-4.6" };
  // Both allow: nobody refused.
  expect(modelLocalityRefusedBy({ mode: "any" }, { mode: "any" }, remote)).toBeNull();
  expect(modelLocalityRefusedBy(null, undefined, remote)).toBeNull();
  // The bot's policy blocks: destinations-bot.
  expect(modelLocalityRefusedBy({ mode: "local" }, { mode: "any" }, remote)).toBe("bot");
  // The space's policy blocks while the bot's allows: destinations-space.
  expect(modelLocalityRefusedBy({ mode: "any" }, { mode: "local" }, remote)).toBe("space");
  // Both block: the bot's is named first.
  expect(modelLocalityRefusedBy({ mode: "local" }, { mode: "local" }, remote)).toBe("bot");
  // An unreadable policy fails closed as a refusal by its owner.
  expect(modelLocalityRefusedBy({ mode: "nope" }, { mode: "any" }, remote)).toBe("bot");
  expect(modelLocalityRefusedBy({ mode: "any" }, { mode: "nope" }, remote)).toBe("space");
});
