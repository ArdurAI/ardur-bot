import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { createRestartDrainRoutes } from "./restart-drain.js";

const id = "00000000-0000-4000-8000-000000000000";
const token = "fake-updater-only-token";
function fixture(credential?: string) {
  const drain = {
    begin: vi.fn(async (id: string = "") => ({
      ok: true,
      id,
      activeAtStart: 0,
      remaining: 0,
      durationMs: 0,
    })),
    clear: vi.fn(async () => {}),
  };
  const app = new Hono().route("/api/restart-drain", createRestartDrainRoutes(drain, credential));
  const request = (path: string, authorization?: string, body = JSON.stringify({ id })) =>
    app.request(`/api/restart-drain${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
      body,
    });
  return { drain, request };
}
it.each([undefined, ""])(
  "denies drain and clear when the updater credential is absent (%s)",
  async (credential) => {
    const f = fixture(credential);
    for (const path of ["", "/clear"]) expect((await f.request(path)).status).toBe(401);
    expect(f.drain.begin).not.toHaveBeenCalled();
    expect(f.drain.clear).not.toHaveBeenCalled();
  },
);
it("denies missing and wrong credentials before parsing the body", async () => {
  const f = fixture(token);
  for (const auth of [undefined, "Bearer fake-wrong-token"])
    expect((await f.request("", auth, "invalid json")).status).toBe(401);
  expect(f.drain.begin).not.toHaveBeenCalled();
});
it("requires a valid request identity on both actions", async () => {
  const f = fixture(token);
  for (const path of ["", "/clear"])
    for (const body of ["not json", "{}", JSON.stringify({ id: "invalid" })])
      expect((await f.request(path, `Bearer ${token}`, body)).status).toBe(400);
  expect(f.drain.begin).not.toHaveBeenCalled();
  expect(f.drain.clear).not.toHaveBeenCalled();
});
it("drains and clears only with the dedicated credential and request identity", async () => {
  const f = fixture(token);
  expect((await f.request("", `Bearer ${token}`)).status).toBe(200);
  expect((await f.request("/clear", `Bearer ${token}`)).status).toBe(200);
  expect(f.drain.begin).toHaveBeenCalledWith(id);
  expect(f.drain.clear).toHaveBeenCalledWith(id);
});
