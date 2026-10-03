import type { ComputerMode } from "@ardurbot/contracts";
import type { Prisma, PrismaClient } from "./client.js";

export type { ComputerMode } from "@ardurbot/contracts";

export function parseComputerMode(scope: string): ComputerMode {
  if (scope === "team" || scope === "dedicated") return scope;
  throw new Error(`Unknown computer scope: ${scope}`);
}

export function computerScopeKey(mode: ComputerMode, spaceId: string, botId?: string) {
  if (mode === "team") return `team:${spaceId}`;
  if (!botId) throw new Error("Dedicated computers require a bot id");
  return `bot:${botId}`;
}

export function computerHomeKey(mode: ComputerMode, spaceId: string, botId?: string) {
  if (mode === "team") return `team-${spaceId}`;
  if (!botId) throw new Error("Dedicated computers require a bot id");
  return botId;
}

type ComputerDb = Pick<PrismaClient, "computer">;
type ExecutionLeaseDb = Pick<PrismaClient, "computerExecutionLease">;

/** Expire leases as fencing tombstones so the next acquire increments fence. */
export async function expireComputerExecutionLeases(
  prisma: ExecutionLeaseDb,
  where: Prisma.ComputerExecutionLeaseWhereInput,
): Promise<void> {
  await prisma.computerExecutionLease.updateMany({
    where,
    data: { expiresAt: new Date(0) },
  });
}

export async function ensureComputerRecord(
  prisma: ComputerDb,
  input: {
    mode: ComputerMode;
    spaceId: string;
    userId: string;
    botId?: string;
    kind: string;
    connectionId?: string | null;
  },
) {
  const scopeKey = computerScopeKey(input.mode, input.spaceId, input.botId);
  if (input.mode === "team") {
    // Older spaces may already share a computer under a noncanonical key.
    const existing = await prisma.computer.findFirst({
      where: { spaceId: input.spaceId, scope: "team" },
      orderBy: [{ bots: { _count: "desc" } }, { createdAt: "asc" }, { id: "asc" }],
    });
    if (existing) return existing;
  }
  return prisma.computer.upsert({
    where: { scopeKey },
    create: {
      spaceId: input.spaceId,
      userId: input.userId,
      scope: input.mode,
      scopeKey,
      homeKey: computerHomeKey(input.mode, input.spaceId, input.botId),
      kind: input.kind,
      ...(input.connectionId !== undefined ? { connectionId: input.connectionId } : {}),
    },
    update: {},
  });
}
