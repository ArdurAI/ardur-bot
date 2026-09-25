import { LOCAL_SETTINGS_TOKEN_HEADER } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import type { Hono } from "hono";
import { validLocalSettingsToken } from "../local-settings.js";

/** Native polling remains authenticated after the web renderer closes. */
export function mountSystemRoutines(app: Hono, prisma: PrismaClient, token?: string) {
  app.get("/local/system/routines", async (c) => {
    c.header("cache-control", "no-store");
    if (!validLocalSettingsToken(token, c.req.header(LOCAL_SETTINGS_TOKEN_HEADER)))
      return c.json({ message: "Open System settings in the desktop app." }, 403);
    return c.json({
      count: await prisma.routine.count({ where: { active: true, bot: { archivedAt: null } } }),
    });
  });
}
