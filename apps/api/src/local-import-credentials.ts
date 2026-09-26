import type { EncryptedSecretStore, ImportOwner } from "@ardurbot/adapters";
import { assertLocalImportOwner, bumpMcpServerRevision } from "@ardurbot/adapters";
import type { PrismaClient } from "@ardurbot/db";
import { IsolationError } from "@ardurbot/db";

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export async function saveImportedServerCredentials(
  prisma: PrismaClient,
  secrets: EncryptedSecretStore,
  owner: ImportOwner,
  input: { serverId: string; env: Record<string, string>; headers: Record<string, string> },
) {
  await prisma.$transaction(async (tx) => {
    const receipt = await tx.localImportRecord.findFirst({
      where: { targetId: input.serverId, removedAt: null, config: owner },
    });
    if (!receipt) throw new IsolationError();
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`local-import:${receipt.configId}`}, 0))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('mcp-oauth-material'), hashtext(${input.serverId}))`;
    await assertLocalImportOwner(tx, owner);
    const server = await tx.mcpServer.findFirst({ where: { id: input.serverId, ...owner } });
    if (!server?.imported) throw new IsolationError();
    const envNames = Object.keys(object(server.env));
    const headerNames = Object.entries(object(server.headers))
      .filter(([, value]) => !object(value).name)
      .map(([key]) => key);
    const complete = (values: Record<string, string>, names: string[]) =>
      Object.keys(values).length === names.length && names.every((name) => values[name]?.trim());
    if (!complete(input.env, envNames) || !complete(input.headers, headerNames))
      throw new Error("Supply a value for each listed field.");
    const previous = server.secretId
      ? await tx.secret.findFirst({ where: { id: server.secretId, ...owner } })
      : null;
    const material = previous
      ? object(JSON.parse(secrets.load(previous.ciphertext, previous.id)))
      : {};
    const stored = await secrets.put(
      JSON.stringify({ ...material, env: input.env, headers: input.headers }),
      {
        ...owner,
        operationId: "local-import.credentials",
        traceId: "local-import.credentials",
        signal: AbortSignal.timeout(10_000),
      },
    );
    await tx.secret.create({ data: { ...stored, ...owner, kind: "mcp" } });
    // Credential setup does not edit the imported definition; later hash updates may still apply.
    if (!(await bumpMcpServerRevision(tx, server.id, owner, { secretId: stored.id })))
      throw new IsolationError();
    if (previous) await tx.secret.deleteMany({ where: { id: previous.id, ...owner } });
  });
  return { ok: true as const };
}
