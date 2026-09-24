import type { Actor, MessageBlock } from "@ardurbot/contracts";
import type { Prisma } from "@ardurbot/db";
import { IsolationError } from "@ardurbot/db";
import { ORPCError } from "@orpc/server";

export type ComposerReference = { kind: "mcp" | "folder"; id: string };

/** References express per-message intent; they never create tool grants or filesystem access. */
export async function resolveComposerReferences(
  tx: Prisma.TransactionClient,
  actor: Actor,
  references: readonly ComposerReference[],
  computerKind?: string,
): Promise<{ note: string; blocks: MessageBlock[] }> {
  const serverIds = [
    ...new Set(references.filter((row) => row.kind === "mcp").map((row) => row.id)),
  ];
  const folders = [
    ...new Set(references.filter((row) => row.kind === "folder").map((row) => row.id)),
  ];
  const servers = serverIds.length
    ? await tx.mcpServer.findMany({
        where: {
          id: { in: serverIds },
          spaceId: actor.spaceId,
          userId: actor.userId,
          enabled: true,
        },
        select: { id: true, name: true, catalogId: true, connectionState: true },
      })
    : [];
  if (
    servers.length !== serverIds.length ||
    servers.some((row) => row.catalogId && row.connectionState !== "connected")
  )
    throw new IsolationError();
  if (folders.length) {
    if (computerKind !== "desktop")
      throw new ORPCError("BAD_REQUEST", { message: "Folders require this computer." });
    const registration = await tx.hostRegistration.findFirst({
      where: { id: "default", userId: actor.userId },
      select: { hostRoots: true },
    });
    if (!registration || folders.some((folder) => !registration.hostRoots.includes(folder))) {
      throw new ORPCError("BAD_REQUEST", {
        message: "Folder is not registered. Add it in Settings and try again.",
      });
    }
  }
  if (!folders.length && !servers.length) return { note: "", blocks: [] };
  const lines = [
    ...(folders.length ? [`Registered folders for this message: ${JSON.stringify(folders)}.`] : []),
    ...(servers.length
      ? [
          `Use these plugins for this message, within existing access: ${JSON.stringify(servers.map((row) => row.name))}.`,
        ]
      : []),
  ];
  return {
    note: lines.join("\n"),
    blocks: [
      {
        kind: "card",
        lines: [...folders, ...servers.map((row) => row.name)].map((value) => ({
          k: "",
          v: value,
        })),
      },
    ],
  };
}
