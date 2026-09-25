import { LOCAL_SETTINGS_TOKEN_HEADER } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { mountSystemRoutines } from "./routines.js";

it("counts active routines across the local stack only with its private token", async () => {
  const app = new Hono(),
    count = vi.fn(async () => 3),
    token = "a".repeat(64);
  mountSystemRoutines(app, { routine: { count } } as unknown as PrismaClient, token);
  for (const supplied of [undefined, "b".repeat(64), "invalid"]) {
    expect(
      (
        await app.request(
          "/local/system/routines",
          supplied ? { headers: { [LOCAL_SETTINGS_TOKEN_HEADER]: supplied } } : {},
        )
      ).status,
    ).toBe(403);
  }
  expect(count).not.toHaveBeenCalled();
  const response = await app.request("/local/system/routines", {
    headers: { [LOCAL_SETTINGS_TOKEN_HEADER]: token },
  });
  expect(await response.json()).toEqual({ count: 3 });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(count).toHaveBeenCalledWith({ where: { active: true, bot: { archivedAt: null } } });
});
