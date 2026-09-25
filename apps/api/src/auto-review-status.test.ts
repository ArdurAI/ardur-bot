import type { Actor } from "@ardurbot/contracts";
import type { Logger } from "@ardurbot/logging";
import { RPCHandler } from "@orpc/server/fetch";
import { afterEach, expect, it, vi } from "vitest";
import { warnAutoReviewConfiguration } from "./auto-review-status.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

afterEach(() => vi.unstubAllEnvs());

it("logs the missing Jev key once without including configuration values", () => {
  const warn = vi.fn();
  const logger = { warn } as unknown as Logger;
  warnAutoReviewConfiguration(logger, {});
  expect(warn).not.toHaveBeenCalled();
  const env = { ARDURBOT_AUTO_REVIEW_PROVIDER: "jev", TYPESAFE_API_KEY: " " };
  warnAutoReviewConfiguration(logger, env);
  warnAutoReviewConfiguration(logger, env);
  expect(warn).toHaveBeenCalledExactlyOnceWith("Jev needs a TypeSafe API key.");
});

it("returns the warning from both status and toggle responses while keeping the local fallback available", async () => {
  vi.stubEnv("ARDURBOT_AUTO_REVIEW_PROVIDER", "jev");
  vi.stubEnv("TYPESAFE_API_KEY", "");
  vi.stubEnv("ARDURBOT_LOCAL_MODELS", "fixture-model");
  let enabled = true;
  const prisma = {
    actionAutoReviewPreference: {
      findUnique: vi.fn(async () => ({ enabled })),
      upsert: vi.fn(async ({ update }) => {
        enabled = update.enabled;
      }),
    },
    userModelCredential: { findFirst: vi.fn(async () => null) },
  };
  const actor: Actor = {
    userId: "owner",
    spaceId: "space",
    email: "owner@example.test",
    isDeploymentOwner: true,
  };
  const handler = new RPCHandler(
    createRouter({
      prisma,
      env: { webOrigin: "https://app.example.test" },
    } as unknown as RouterDeps),
  );
  for (const [method, input] of [
    ["get", undefined],
    ["set", { enabled: false }],
  ] as const) {
    const { response } = await handler.handle(
      new Request(`https://app.example.test/rpc/autoReview/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      json: {
        enabled: method === "get",
        checkerAvailable: true,
        configurationWarning: "jev-key-missing",
      },
    });
  }
  expect(prisma.userModelCredential.findFirst).not.toHaveBeenCalled();
});
