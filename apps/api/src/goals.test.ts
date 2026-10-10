import { ORPCError } from "@orpc/server";
import { describe, expect, it } from "vitest";
import { createRouter } from "./router.js";

import type { RouterDeps } from "./router.js";

describe("Goals API", () => {
  it("enforces deployment-owner on accept and reject", async () => {
    // We only need prisma for the types, we don't actually call it because the auth check fails first.
    const router = createRouter({
      prisma: {},
      env: { sandboxProvider: "fake" },
    } as unknown as RouterDeps);

    // non-owner context
    const nonOwnerContext = {
      actor: {
        spaceId: "space_1",
        userId: "user_1",
        isDeploymentOwner: false,
        kind: "human" as const,
        id: "user_1",
      },
      authSessionId: "123",
      deviceToken: null,
    };

    const { RPCHandler } = await import("@orpc/server/fetch");
    const handler = new RPCHandler(router);

    const call = async (path: string, body: unknown) => {
      const { response } = await handler.handle(
        new Request(`http://127.0.0.1/rpc/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: body }),
        }),
        { prefix: "/rpc", context: nonOwnerContext },
      );
      return response;
    };

    const resAccept = await call("goals/accept", { goalId: "g_1", revisionId: "r_1" });
    const jsonAccept = await resAccept.json();
    expect(resAccept.status).toBe(403);
    expect(jsonAccept.json?.code).toBe("FORBIDDEN");

    const resReject = await call("goals/reject", { goalId: "g_1", revisionId: "r_1", reworkNotes: "fix" });
    const jsonReject = await resReject.json();
    expect(resReject.status).toBe(403);
    expect(jsonReject.json?.code).toBe("FORBIDDEN");
  });
});
