import { createHash } from "node:crypto";
import type {
  AdapterContext,
  AgentRuntimeEvent,
  ComputerRef,
  SandboxProvider,
} from "@ardurbot/adapter-kit";
import { CommandEventPayloadSchema, CommandRequestSchema } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { isToolPauseResult } from "./approval-effect.js";
import { resolveBotWorkspaceCwd } from "./computer-support.js";

export const COMMAND_COMPUTER_CHANGED =
  "The computer or its workspace changed since this command ran.";
export const COMMAND_REPLAY_UNAVAILABLE =
  "The original command cannot be retained safely for rerun.";

export class CommandReplayUnavailableError extends Error {}

type ComputerIdentity = {
  id: string;
  kind: string;
  scope: string;
  homeKey: string;
  providerRef: string | null;
};

export function commandComputerFingerprint(
  computer: ComputerIdentity,
  providerRef: string,
  cwd: string,
) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        computer.id,
        computer.kind,
        computer.scope,
        computer.homeKey,
        providerRef,
        cwd,
      ]),
    )
    .digest("hex");
}

export function validateCommandReplay(
  payload: unknown,
  computer: ComputerIdentity,
  resolvedCwd?: string,
) {
  const parsed = CommandEventPayloadSchema.safeParse(payload);
  if (!parsed.success || !parsed.data.replay || !parsed.data.block.cwd) {
    return { reason: COMMAND_REPLAY_UNAVAILABLE } as const;
  }
  const { block, replay } = parsed.data;
  if (
    !computer.providerRef ||
    block.computerId !== computer.id ||
    replay.computerFingerprint !==
      commandComputerFingerprint(computer, computer.providerRef, resolvedCwd ?? block.cwd!)
  ) {
    return { reason: COMMAND_COMPUTER_CHANGED } as const;
  }
  const request = CommandRequestSchema.parse(replay.request);
  return { commandId: block.commandId, request } as const;
}

export async function loadRunCommandReplay(input: {
  prisma: PrismaClient;
  run: { commandReplayId: string | null; userId: string; spaceId: string; botId: string };
  storedComputer: ComputerIdentity;
  computer: ComputerRef;
  sandbox: SandboxProvider;
  context: AdapterContext;
}) {
  if (!input.run.commandReplayId) return null;
  const event = await input.prisma.event.findFirst({
    where: {
      type: "command.intent",
      spaceId: input.run.spaceId,
      botId: input.run.botId,
      payload: { path: ["block", "commandId"], equals: input.run.commandReplayId },
    },
    orderBy: { seq: "asc" },
  });
  const original = event?.runId
    ? await input.prisma.run.findFirst({
        where: {
          id: event.runId,
          userId: input.run.userId,
          spaceId: input.run.spaceId,
          botId: input.run.botId,
        },
      })
    : null;
  if (!original) throw new CommandReplayUnavailableError(COMMAND_REPLAY_UNAVAILABLE);
  const preliminary = validateCommandReplay(event!.payload, {
    ...input.storedComputer,
    providerRef: input.computer.providerRef,
  });
  if ("reason" in preliminary) throw new CommandReplayUnavailableError(preliminary.reason);
  const cwd = resolveBotWorkspaceCwd(
    input.storedComputer.scope === "team" ? "team" : "dedicated",
    input.run.botId,
    preliminary.request.cwd,
  );
  const resolvedCwd = await input.sandbox.resolveCommandCwd?.(input.computer, cwd, input.context);
  if (!resolvedCwd) throw new CommandReplayUnavailableError(COMMAND_REPLAY_UNAVAILABLE);
  const replay = validateCommandReplay(
    event!.payload,
    {
      ...input.storedComputer,
      providerRef: input.computer.providerRef,
    },
    resolvedCwd,
  );
  if ("reason" in replay) throw new CommandReplayUnavailableError(replay.reason);
  return replay;
}

/** No model reconstructs a rerun. The callback is the ordinary authoritative tool path. */
export async function* commandReplayEvents(
  replay: { commandId: string; request: { command: string; cwd?: string } },
  runId: string,
  applyTool: (name: string, args: Record<string, unknown>, executionId: string) => Promise<unknown>,
): AsyncIterable<AgentRuntimeEvent> {
  const result = await applyTool("shell", replay.request, `rerun:${runId}`);
  if (isToolPauseResult(result)) return;
  yield {
    type: "done",
    text:
      result && typeof result === "object" && "error" in result
        ? "The command could not finish."
        : "Command rerun finished.",
  };
}
