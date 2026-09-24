import type { DelegationKind, DelegationSnapshot, RuntimeProblem } from "@ardurbot/contracts";
import { DelegationSnapshotSchema, RuntimePinSchema, runtimePinProblem } from "@ardurbot/contracts";
import type { Bot, Prisma, PrismaClient, ThreadEvents } from "@ardurbot/db";
import {
  admitDelegation,
  DelegationAdmissionError,
  finishDelegation,
  inheritedRemoteOrigin,
} from "@ardurbot/db";
import { destinationForModel } from "./model-locality.js";
import type { ResolvedRunPin } from "./run-model-pin.js";

export type DelegationResolver = (bot: Bot) => Promise<ResolvedRunPin | RuntimeProblem>;
export async function prepareDelegation(
  tx: Prisma.TransactionClient,
  input: {
    spaceId: string;
    userId: string;
    parentRunId: string;
    actingBotId: string;
    actingName: string;
    kind: DelegationKind;
    admissionKey: string;
    prompt: string;
    newChild?: boolean;
  },
  resolve?: DelegationResolver,
) {
  const parent = await tx.run.findUniqueOrThrow({ where: { id: input.parentRunId } });
  const inherited = input.kind === "helper" || input.kind === "child";
  const bot = await tx.bot.findFirstOrThrow({
    where: {
      id: inherited ? parent.botId : input.actingBotId,
      spaceId: input.spaceId,
      userId: input.userId,
    },
    include: { computer: true },
  });
  let snapshot: DelegationSnapshot;
  if (inherited && parent.delegationId) {
    const row = await tx.delegation.findUniqueOrThrow({ where: { id: parent.delegationId } });
    snapshot = DelegationSnapshotSchema.parse(row.snapshot);
  } else {
    const pin = RuntimePinSchema.safeParse(parent.runtimePin);
    if (inherited && !pin.success)
      throw new Error("The parent's resolved pin is unavailable; restart the task.");
    const selected = inherited ? undefined : await resolve?.(bot);
    if (!inherited && (!selected || selected.kind === "problem")) {
      const problem =
        selected ??
        runtimePinProblem(
          pin.success
            ? pin.data
            : {
                runtimeKind: "pi" as const,
                provider: null,
                modelId: null,
                credentialId: null,
                effort: null,
                revision: 0,
              },
          "pin-incomplete",
          "The recipient pin could not be resolved.",
        );
      return { ok: false as const, error: problem.reason, problem };
    }
    snapshot = {
      pin: inherited ? pin.data! : selected!.pin,
      computer:
        inherited && parent.runtimeComputer
          ? DelegationSnapshotSchema.shape.computer.parse(parent.runtimeComputer)
          : {
              id: bot.computerId,
              mode: bot.computer?.scope === "dedicated" ? "dedicated" : "team",
              kind: bot.computer?.kind ?? null,
            },
      destination: inherited
        ? ((parent.runtimeDestination as DelegationSnapshot["destination"]) ?? {
            host: null,
            local: false,
          })
        : destinationForModel(selected! as ResolvedRunPin),
    };
  }
  const record = await admitDelegation(tx, { ...input, snapshot });
  const admittedSnapshot = DelegationSnapshotSchema.parse(record.snapshot);
  return {
    ok: true as const,
    record,
    runData: {
      ...(await inheritedRemoteOrigin(tx, parent.id)),
      delegationId: record.id,
      delegationRootTaskId: record.rootTaskId,
      runtimePin: admittedSnapshot.pin,
      runtimeDestination: admittedSnapshot.destination,
      runtimeComputer: admittedSnapshot.computer,
    },
  };
}
export function delegationFailure(error: unknown) {
  if (error instanceof DelegationAdmissionError)
    return { ok: false as const, error: error.message, problem: error.problem };
  throw error;
}
export async function completeHelper(
  prisma: PrismaClient,
  id: string,
  status: "completed" | "failed" | "cancelled",
  result: string,
  events?: Pick<ThreadEvents, "notify">,
) {
  const event = await prisma.$transaction((tx) => finishDelegation(tx, id, status, result));
  if (event) await events?.notify(event.threadId, event.seq);
}
