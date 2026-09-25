import { connectMcpOauth } from "../../lib/mcp-connect";
import { rpc } from "../../lib/rpc";

/** Returns the server id, or null when the person cancels browser sign-in. */
export async function connectRemoteMcp(input: {
  name: string;
  endpoint: string;
  secret?: string;
  botId?: string;
}): Promise<string | null> {
  const endpoint = input.endpoint.trim();
  const secret = input.secret?.trim();
  const existing = (await rpc.mcp.servers.list()).find((server) => server.endpoint === endpoint);
  const server =
    existing ??
    (await rpc.mcp.servers.create({
      slug: `integration-${crypto.randomUUID().slice(0, 8)}`,
      name: input.name,
      transport: "streamable_http",
      endpoint,
      ...(secret ? { secret } : {}),
    }));
  if (existing && secret) await rpc.mcp.servers.update({ id: existing.id, secret });
  const result = await connectMcpOauth(server.id);
  if (result === "cancelled") return null;
  if (input.botId) await rpc.mcp.assignments.approve({ botId: input.botId, serverId: server.id });
  return server.id;
}
