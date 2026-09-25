import type {
  AdapterContext,
  ComputerRef,
  ConnectorEvent,
  SandboxProvider,
} from "@ardurbot/adapter-kit";
import type { HostCommandApproval } from "@ardurbot/contracts";
import {
  canonicalDispatchJson,
  HostIntegrationSchema,
  hostIntegrationCommand,
  IntegrationManifestSchema,
} from "@ardurbot/contracts";
import type { McpServer, PrismaClient } from "@ardurbot/db";
import { toComputerRef } from "./computer-support.js";
import { nativeHostOwner } from "./runtimes/native-host.js";

export const hostIntegrationTools = [
  {
    name: "get_identity",
    description: "Read the connected CLI account and workspace.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "execute_command",
    description:
      "Execute a command with the owner's CLI sign-in on this computer. Always asks for approval. Authentication and credential commands are unavailable.",
    inputSchema: {
      type: "object",
      properties: { args: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 48 } },
      required: ["args"],
      additionalProperties: false,
    },
  },
];

export async function hostIntegrationComputer(prisma: PrismaClient, context: AdapterContext) {
  if (!context.botId || !(await nativeHostOwner(prisma, context.userId))) return null;
  const bot = await prisma.bot.findFirst({
    where: { id: context.botId, userId: context.userId, spaceId: context.spaceId },
    include: { computer: true },
  });
  return bot?.computer?.kind === "desktop" && bot.computer.providerRef ? bot.computer : null;
}

export async function prepareHostCommandApproval(
  prisma: PrismaClient,
  sandbox: SandboxProvider | undefined,
  server: McpServer,
  args: Record<string, unknown>,
  context: AdapterContext,
): Promise<{ approval: HostCommandApproval; computer: ComputerRef }> {
  const computer = await hostIntegrationComputer(prisma, context);
  if (!computer || !sandbox) throw new Error("This integration requires a bot on This computer.");
  const argv = hostIntegrationCommand(server.catalogId!, args);
  const manifest = IntegrationManifestSchema.parse(server.manifest);
  if (!manifest.account) throw new Error("Reconnect this integration on this computer.");
  const cwd = await sandbox.resolveCommandCwd?.(toComputerRef(computer), undefined, context);
  if (!cwd) throw new Error("The command's working directory is unavailable. Try again.");
  const approval: HostCommandApproval = {
    id: HostIntegrationSchema.shape.id.parse(server.catalogId),
    argv,
    identity: manifest.account,
    workspace: manifest.workspace ?? null,
    cwd,
    computerId: computer.id,
  };
  return { approval, computer: toComputerRef(computer) };
}

export function hostCommandApprovalMatches(
  approved: HostCommandApproval | undefined,
  current: HostCommandApproval,
): boolean {
  return Boolean(approved && canonicalDispatchJson(approved) === canonicalDispatchJson(current));
}

export async function* executeHostIntegration(
  prisma: PrismaClient,
  sandbox: SandboxProvider | undefined,
  server: McpServer,
  tool: string,
  args: Record<string, unknown>,
  context: AdapterContext,
): AsyncIterable<ConnectorEvent> {
  if (!sandbox) throw new Error("This integration requires a bot on This computer.");
  if (tool === "get_identity") {
    if (!(await hostIntegrationComputer(prisma, context)))
      throw new Error("This integration requires a bot on This computer.");
    const manifest = server.manifest as { account?: string; workspace?: string };
    yield { type: "result", data: { account: manifest.account, workspace: manifest.workspace } };
    return;
  }
  if (tool !== "execute_command") throw new Error("Unknown host integration tool.");
  const { approval: current, computer } = await prepareHostCommandApproval(
    prisma,
    sandbox,
    server,
    args,
    context,
  );
  if (!hostCommandApprovalMatches(context.hostCommandApproval, current))
    throw new Error("This command changed or has no approval. Review it again.");
  const { argv, cwd, id, identity, workspace } = current;
  const hostIntegration = { id, identity, workspace };
  let output = "";
  let code: number | undefined;
  for await (const event of sandbox.execute(
    computer,
    { argv, cwd, timeoutMs: 60_000, hostIntegration },
    context,
  )) {
    if (event.type === "exit") code = event.code;
    else if (event.type === "stdout") output = (output + event.data).slice(0, 128 * 1024);
    // CLI diagnostics can include credential sources; do not persist stderr.
  }
  if (code !== 0)
    throw new Error("The CLI command did not complete. Check the sign-in on this computer.");
  yield { type: "result", data: { output } };
}
