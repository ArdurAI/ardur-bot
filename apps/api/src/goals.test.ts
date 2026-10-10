import { RPCHandler } from "@orpc/server/fetch";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

describe("Goals API", () => {
  it.each([
    { name: "a non-owner session", isDeploymentOwner: false, authSessionId: "session-1" },
    {
      name: "an owner without an authenticated session",
      isDeploymentOwner: true,
      authSessionId: undefined,
    },
  ])("refuses accept and reject from $name", async ({ isDeploymentOwner, authSessionId }) => {
    const findFirst = vi.fn();
    const router = createRouter({
      prisma: { teamGoal: { findFirst } },
      env: { sandboxProvider: "fake" },
    } as unknown as RouterDeps);
    const context = {
      actor: {
        spaceId: "space-1",
        userId: "owner-1",
        email: "owner@example.test",
        isDeploymentOwner,
      },
      authSessionId,
    };
    const handler = new RPCHandler(router);
    for (const operation of ["accept", "reject"]) {
      const { response } = await handler.handle(
        new Request(`http://127.0.0.1/rpc/goals/${operation}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            json: {
              goalId: "goal-1",
              revisionId: "revision-1",
              reworkNotes: "Review again",
            },
          }),
        }),
        { prefix: "/rpc", context },
      );
      expect(response?.status).toBe(403);
      expect(await response?.json()).toMatchObject({ json: { code: "FORBIDDEN" } });
    }
    expect(findFirst).not.toHaveBeenCalled();
  });
});
