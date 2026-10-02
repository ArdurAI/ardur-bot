import type { RuntimeComputerLocation } from "@ardurbot/contracts";
import { ComputerConnectionSettingsSchema } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";

/** Resolve placement without provisioning or probing a computer. Missing connections fail closed. */
export async function runtimeComputerLocation(
  prisma: PrismaClient,
  computer: { kind: string; connectionId?: string | null; spaceId: string } | null | undefined,
): Promise<RuntimeComputerLocation> {
  if (computer?.connectionId === undefined || computer.connectionId === null)
    return { kind: computer?.kind };
  if (computer.connectionId === "")
    return { kind: computer.kind, connectionId: "", connectionSettings: null };
  const connection = await prisma.connection.findFirst({
    where: { id: computer.connectionId, spaceId: computer.spaceId, connectorId: "computer" },
  });
  const settings = ComputerConnectionSettingsSchema.safeParse(connection?.metadata);
  return {
    kind: computer.kind,
    connectionId: computer.connectionId,
    connectionSettings: settings.success ? settings.data : null,
  };
}
