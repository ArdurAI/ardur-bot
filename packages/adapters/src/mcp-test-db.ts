/** Adapt explicit-row fixtures to the server-first listing used by discovery. */
export function serverFirstMcpFixture<T extends Record<string, unknown>>(db: T): T {
  const rows = db.botMcpServer as
    | {
        findMany?: () => Promise<
          Array<{
            botId: string;
            spaceId: string;
            userId: string;
            allowedTools: unknown;
            server: Record<string, unknown>;
          }>
        >;
      }
    | undefined;
  if (!rows?.findMany || db.mcpServer) return db;
  return {
    ...db,
    bot: {
      findFirst: async ({ where }: { where: { id: string; spaceId: string; userId: string } }) => {
        const assignments = await rows.findMany!();
        return assignments.some(
          (row) =>
            row.botId === where.id && row.spaceId === where.spaceId && row.userId === where.userId,
        )
          ? { id: where.id, computer: { kind: "desktop" } }
          : null;
      },
    },
    mcpServer: {
      findMany: async ({ where }: { where: { spaceId: string; userId: string } }) => {
        const assignments = await rows.findMany!();
        return assignments
          .filter((row) => row.spaceId === where.spaceId && row.userId === where.userId)
          .map((row) => ({
            ...row.server,
            spaceAllowedTools: row.server.spaceAllowedTools ?? row.allowedTools,
            assignments: [row],
          }));
      },
    },
  } as T;
}
