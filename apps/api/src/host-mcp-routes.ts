import type { EncryptedSecretStore } from "@ardurbot/adapters";
import { HostMcpRegistrationSchema } from "@ardurbot/contracts/host-bridge";
import type { PrismaClient } from "@ardurbot/db";
import type { Hono } from "hono";
import type { HostBridge } from "./host-bridge.js";

/** Launch definitions travel only to the paired host, never through the worker operation wire. */
export function mountHostMcpRoutes(
  app: Hono,
  deps: { prisma: PrismaClient; secrets: EncryptedSecretStore; hostBridge: HostBridge },
) {
  app.get("/api/host-bridge/mcp", async (c) => {
    if (c.req.header("origin")) return c.json({ error: "Forbidden" }, 403);
    const registration = await deps.hostBridge.registrationFor(c.req.header("authorization"));
    if (!registration) return c.json({ error: "Unauthorized" }, 401);
    const rows = await deps.prisma.mcpServer.findMany({
      where: { userId: registration.userId, placement: "host", transport: "stdio", enabled: true },
      include: { secret: true },
      take: 201,
    });
    if (rows.length > 200) return c.json({ error: "Too many local servers." }, 409);
    const servers = rows.map((row) => {
      if (!row.secret || row.secret.userId !== row.userId || row.secret.spaceId !== row.spaceId)
        throw new Error("Local server configuration is unavailable.");
      const material = JSON.parse(deps.secrets.load(row.secret.ciphertext, row.secret.id));
      return HostMcpRegistrationSchema.parse({
        serverId: row.id,
        userId: row.userId,
        spaceId: row.spaceId,
        revision: row.revision,
        command: material.command ?? row.command,
        args: material.args ?? row.args,
        env: material.env ?? {},
        cwd: material.cwd ?? ".",
        redactions: material.redactions ?? [],
      });
    });
    c.header("cache-control", "no-store");
    return c.json(servers);
  });
}
