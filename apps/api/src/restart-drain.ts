import type { RestartDrain } from "@ardurbot/adapters";
import { hasValidBearerToken } from "@ardurbot/core";
import { Hono } from "hono";

export function createRestartDrainRoutes(
  drain: Pick<RestartDrain, "begin" | "clear">,
  token?: string,
) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (!token || !hasValidBearerToken(c.req.header("authorization"), token))
      return c.json({ error: "Unauthorized" }, 401);
    return next();
  });
  const drainId = async (request: Request): Promise<string | undefined> => {
    const input: unknown = await request.json().catch(() => undefined);
    if (!input || typeof input !== "object" || !("id" in input) || typeof input.id !== "string")
      return undefined;
    return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.id)
      ? input.id
      : undefined;
  };
  app.post("/", async (c) => {
    const id = await drainId(c.req.raw);
    if (!id) return c.json({ error: "Invalid drain" }, 400);
    return c.json(await drain.begin(id));
  });
  app.post("/clear", async (c) => {
    const id = await drainId(c.req.raw);
    if (!id) return c.json({ error: "Invalid drain" }, 400);
    await drain.clear(id);
    return c.json({ ok: true });
  });
  return app;
}
