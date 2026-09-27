import { expect, it, vi } from "vitest";
import { createDeploymentOwnerFixture } from "./deployment-owner.js";

function request(method: string, sessionId: string) {
  return new Request("http://127.0.0.1/__e2e/deployment-owner", {
    method,
    headers: { "x-session": sessionId },
  });
}

it("holds ownership across concurrent claims until the first session releases it", async () => {
  const setOwner = vi.fn(async (_userId: string) => {});
  const route = createDeploymentOwnerFixture({
    authenticate: async (incoming) => {
      const sessionId = incoming.headers.get("x-session");
      return sessionId ? { sessionId, userId: sessionId } : null;
    },
    setOwner,
    waitMs: 1_000,
  });

  expect((await route(request("POST", "first"))).status).toBe(200);
  let secondFinished = false;
  const second = route(request("POST", "second")).then((response) => {
    secondFinished = true;
    return response;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(secondFinished).toBe(false);
  expect(setOwner).toHaveBeenCalledTimes(1);
  expect((await route(request("DELETE", "second"))).status).toBe(403);
  expect((await route(request("DELETE", "first"))).status).toBe(204);
  expect((await second).status).toBe(200);
  expect(setOwner.mock.calls.map(([userId]) => userId)).toEqual(["first", "second"]);
});

it("returns Locked after waiting and allows a new claim when the lease expires", async () => {
  const setOwner = vi.fn(async (_userId: string) => {});
  const route = createDeploymentOwnerFixture({
    authenticate: async (incoming) => {
      const sessionId = incoming.headers.get("x-session");
      return sessionId ? { sessionId, userId: sessionId } : null;
    },
    setOwner,
    waitMs: 20,
    leaseMs: 1_000,
  });

  expect((await route(request("POST", "first"))).status).toBe(200);
  expect((await route(request("POST", "second"))).status).toBe(423);
  const afterExpiry = Date.now() + 1_001;
  const clock = vi.spyOn(Date, "now").mockReturnValue(afterExpiry);
  try {
    expect((await route(request("POST", "second"))).status).toBe(200);
  } finally {
    clock.mockRestore();
  }
});
