import { expect, it, vi } from "vitest";
import {
  createDeploymentOwnerFixture,
  DEPLOYMENT_OWNER_LEASE_MS,
  DEPLOYMENT_OWNER_RENEW_MS,
} from "./deployment-owner.js";

function request(method: string, sessionId: string, signal?: AbortSignal) {
  return new Request("http://127.0.0.1/__e2e/deployment-owner", {
    method,
    headers: { "x-session": sessionId },
    signal,
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

it("keeps a renewing holder and expires a silent holder", async () => {
  const setOwner = vi.fn(async (_userId: string) => {});
  const route = createDeploymentOwnerFixture({
    authenticate: async (incoming) => {
      const sessionId = incoming.headers.get("x-session");
      return sessionId ? { sessionId, userId: sessionId } : null;
    },
    setOwner,
    waitMs: 20,
  });

  const actualNow = Date.now;
  let offset = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => actualNow() + offset);
  try {
    expect((await route(request("POST", "first"))).status).toBe(200);
    offset = DEPLOYMENT_OWNER_RENEW_MS;
    expect((await route(request("POST", "first"))).status).toBe(200);
    offset = DEPLOYMENT_OWNER_LEASE_MS + 1;
    expect((await route(request("POST", "second"))).status).toBe(423);
    offset = DEPLOYMENT_OWNER_RENEW_MS + DEPLOYMENT_OWNER_LEASE_MS + 1;
    expect((await route(request("POST", "second"))).status).toBe(200);
    expect(setOwner.mock.calls.map(([userId]) => userId)).toEqual(["first", "first", "second"]);
  } finally {
    clock.mockRestore();
  }
});

it("does not grant ownership to an aborted waiter", async () => {
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
  const controller = new AbortController();
  const second = route(request("POST", "second", controller.signal));
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  await expect(second).rejects.toMatchObject({ name: "AbortError" });
  expect((await route(request("DELETE", "first"))).status).toBe(204);
  expect((await route(request("POST", "third"))).status).toBe(200);
  expect(setOwner.mock.calls.map(([userId]) => userId)).toEqual(["first", "third"]);
});
