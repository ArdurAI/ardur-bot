import type { JobPublisher } from "@ardurbot/adapter-kit";
import { runContinueJob } from "@ardurbot/adapter-kit";
import type { ChatCard, ChatEvent, MessageBlock } from "@ardurbot/contracts";
import { CHAT_COPY, ChatEventSchema, looksLikeChatSecret } from "@ardurbot/contracts";
import {
  buildChannelMessagePrompt,
  classifyRemoteTool,
  remotePermissionExpansion,
} from "@ardurbot/core";
import type { ChatInstallation, PrismaClient, ThreadEvents } from "@ardurbot/db";
import {
  acceptChatEvent,
  admitDispatch,
  auditDevice,
  authenticateChannel,
  DeviceRequestError,
  deviceDigest,
  enqueueChat,
  findChatReplyTask,
  redeemChannelPairing,
  requestDispatchStop,
} from "@ardurbot/db";
import { approvalRequestRoute, validateDeviceApproval } from "../remote-execution.js";

export function createMessagingDispatch(deps: {
  prisma: PrismaClient;
  jobs: JobPublisher;
  events: ThreadEvents;
}) {
  const { prisma } = deps;
  async function reply(installation: ChatInstallation, event: ChatEvent, text: string) {
    await enqueueChat(prisma, {
      key: `reply:${installation.id}:${event.eventId}`,
      installationId: installation.id,
      destination: event,
      card: { text },
    });
  }
  return {
    async receive(installation: ChatInstallation, raw: ChatEvent, sensitiveValues: string[] = []) {
      const event = ChatEventSchema.parse(raw);
      if (
        sensitiveValues.some(
          (value) =>
            value &&
            [event.text, ...(event.attachments ?? []).map((item) => item.text)].some((text) =>
              text.includes(value),
            ),
        )
      )
        event.rejectedAttachment = "secret";
      if (event.provider !== installation.provider)
        throw new DeviceRequestError("This channel is unavailable.");
      if (event.provider === "discord" && event.private && event.workspaceId === "@direct")
        event.workspaceId = installation.workspaceId;
      if (
        !event.rejectedAttachment &&
        !event.attachmentCount &&
        event.private &&
        /^[A-F0-9]{12}$/i.test(event.text.trim()) &&
        !event.action
      ) {
        try {
          await redeemChannelPairing(prisma, installation, event);
        } catch (error) {
          if (!(error instanceof DeviceRequestError)) throw error;
          await reply(installation, event, error.message);
        }
        return;
      }
      await acceptChatEvent(prisma, installation.id, event);
    },
    async consume(installation: ChatInstallation, event: ChatEvent) {
      try {
        if (event.addressed === false) return;
        // Defense in depth for old or manually inserted inbox rows.
        if (looksLikeChatSecret(event.text) || looksLikeChatSecret(event.action ?? "")) {
          await reply(installation, event, CHAT_COPY.secrets);
          return;
        }
        const grant = await authenticateChannel(prisma, installation, event);
        if (!grant) {
          await reply(installation, event, CHAT_COPY.pair);
          return;
        }
        if (event.action) {
          const match = /^(allow|deny):([a-f0-9-]{36})$/.exec(event.action);
          if (!match) {
            await reply(installation, event, "Review this request at home.");
            return;
          }
          const binding = await prisma.deviceApprovalBinding.findUnique({
            where: { nonce: match[2]! },
          });
          const origin = binding
            ? await prisma.messagingTaskOrigin.findFirst({
                where: {
                  taskId: binding.taskId,
                  grantId: grant.id,
                  installationId: installation.id,
                  workspaceId: event.workspaceId,
                  channelId: event.channelId,
                },
              })
            : null;
          if (!binding || !origin || binding.originDeviceGrantId !== grant.id)
            throw new DeviceRequestError("This approval is unavailable.");
          const effect = await prisma.externalEffect.findUnique({
            where: { id: binding.effectId },
          });
          const route = approvalRequestRoute(effect?.request);
          if (
            !route ||
            classifyRemoteTool(route.toolName) !== "ordinary" ||
            remotePermissionExpansion(route.toolName)
          ) {
            await auditDevice(prisma, "remote.consequential.blocked", {
              instanceId: grant.instanceId,
              userId: grant.userId,
              spaceId: grant.spaceId,
              grantId: grant.id,
              taskId: origin.taskId,
              effectId: binding.effectId,
            });
            await reply(installation, event, CHAT_COPY.stronger);
            return;
          }
          const run = await prisma.run.findUnique({ where: { id: binding.runId } });
          if (!run) throw new DeviceRequestError("This approval is unavailable.");
          const messages = await prisma.message.findMany({
            where: { runId: run.id, role: "bot" },
            orderBy: { seq: "desc" },
            take: 50,
          });
          const message = messages.find((m) =>
            asks(m.blocks).some((ask) => ask.approvalEffectId === binding.effectId),
          );
          if (!message) throw new DeviceRequestError("This approval is unavailable.");
          const answered = await deps.events.answerRunInput({
            spaceId: run.spaceId,
            threadId: run.threadId,
            runId: run.id,
            messageId: message.id,
            answeredByUserId: grant.userId,
            answer: match[1]!,
            deviceApprovalValidator: (tx, current) =>
              validateDeviceApproval(tx, current, {
                effectId: binding.effectId,
                nonce: binding.nonce,
                requestFingerprint: binding.requestFingerprint,
                instanceId: grant.instanceId,
                grantId: grant.id,
                decision: match[1] as "allow" | "deny",
              }),
          });
          if (!answered)
            throw new DeviceRequestError(
              "This approval changed or expired; review it again at home.",
              409,
            );
          await deps.jobs.enqueue(runContinueJob(run.id)).catch(() => undefined);
          await reply(installation, event, "Answer received.");
          return;
        }
        const target = await findChatReplyTask(prisma, installation.id, grant.id, event);
        if (event.text.trim().toLowerCase() === "stop" && target) {
          await requestDispatchStop(prisma, grant, target.taskId);
          await deps.jobs.enqueue(runContinueJob(target.runId)).catch(() => undefined);
          // Only the executor's confirmed DispatchSummary may say Stopped.
          await reply(installation, event, "Stop requested.");
          return;
        }
        if ((event.replyTo || event.threadId) && !target) {
          await reply(installation, event, "Reply to this task's message, or send a new message.");
          return;
        }
        if (!event.text.trim() && !event.attachments?.length) return;
        const result = await admitDispatch(
          prisma,
          grant,
          {
            clientNonce: deviceDigest(`${installation.id}:${event.eventId}`),
            text: buildChannelMessagePrompt(event.text, event.attachments),
            ...(target ? { botId: target.botId, replyToTaskId: target.taskId } : {}),
          },
          {
            installationId: installation.id,
            provider: event.provider,
            workspaceId: event.workspaceId,
            channelId: event.channelId,
            threadId: event.threadId,
            messageId: event.messageId,
            private: event.private,
          },
        );
        await deps.jobs.enqueue(runContinueJob(result.runId)).catch(() => undefined);
      } catch (error) {
        if (!(error instanceof DeviceRequestError)) throw error;
        await reply(installation, event, error.message);
      }
    },
    async notifications(installation: ChatInstallation) {
      // Terminal summaries are retained until sent; no per-message transcript mirroring.
      const origins = await prisma.messagingTaskOrigin.findMany({
        where: { installationId: installation.id, finishedAt: null },
        orderBy: { createdAt: "asc" },
        take: 256,
      });
      for (const origin of origins) {
        const grant = await prisma.deviceGrant.findFirst({
          where: { id: origin.grantId, revokedAt: null },
        });
        if (!grant) {
          await prisma.messagingTaskOrigin.update({
            where: { taskId: origin.taskId },
            data: { finishedAt: new Date() },
          });
          continue;
        }
        const destination = {
          workspaceId: origin.workspaceId,
          channelId: origin.channelId,
          ...(origin.threadId ? { threadId: origin.threadId } : {}),
        };
        const summary = await prisma.dispatchSummary.findUnique({
          where: { taskId: origin.taskId },
        });
        if (summary) {
          const message = summary.messageId
            ? await prisma.message.findUnique({ where: { id: summary.messageId } })
            : null;
          const blocks = Array.isArray(message?.blocks) ? (message.blocks as MessageBlock[]) : [];
          const text =
            summary.state === "stopped"
              ? CHAT_COPY.stopped
              : blocks
                  .filter((b): b is Extract<MessageBlock, { kind: "text" }> => b.kind === "text")
                  .map((b) => b.text)
                  .join("\n") ||
                (summary.state === "failed"
                  ? "This task could not finish. Review it at home."
                  : "Done.");
          await enqueueChat(prisma, {
            key: `summary:${origin.taskId}`,
            taskId: origin.taskId,
            installationId: installation.id,
            destination,
            card: { text },
          });
          await prisma.messagingTaskOrigin.update({
            where: { taskId: origin.taskId },
            data: { finishedAt: new Date() },
          });
          continue;
        }
        const run = await prisma.run.findUnique({ where: { id: origin.runId } });
        if (!run) continue;
        if (run.status === "waiting_input") {
          const messages = await prisma.message.findMany({
            where: { runId: run.id, role: "bot" },
            orderBy: { seq: "desc" },
            take: 50,
          });
          for (const message of messages)
            for (const ask of asks(message.blocks)) {
              const binding = ask.approvalEffectId
                ? await prisma.deviceApprovalBinding.findUnique({
                    where: { effectId: ask.approvalEffectId },
                  })
                : null;
              if (binding?.answeredAt) continue;
              const effect = binding
                ? await prisma.externalEffect.findUnique({ where: { id: binding.effectId } })
                : null;
              const route = approvalRequestRoute(effect?.request);
              let card: ChatCard = { text: CHAT_COPY.stronger };
              if (ask.input === "secret") card = { text: CHAT_COPY.secrets };
              else if (!ask.approvalEffectId && !ask.actions?.length)
                card = { text: [ask.text, ask.detail].filter(Boolean).join("\n") };
              if (
                binding &&
                binding.expiresAt > new Date() &&
                route &&
                classifyRemoteTool(route.toolName) === "ordinary" &&
                !remotePermissionExpansion(route.toolName)
              ) {
                card = {
                  text: [ask.text, ask.detail].filter(Boolean).join("\n"),
                  actions: [
                    {
                      label: ask.actions?.find((a) => a.id === "allow")?.label ?? "Allow once",
                      value: `allow:${binding.nonce}`,
                    },
                    { label: "Cancel", value: `deny:${binding.nonce}` },
                  ],
                };
              }
              await enqueueChat(prisma, {
                key: `attention:${origin.taskId}:${binding?.effectId ?? message.id}`,
                taskId: origin.taskId,
                installationId: installation.id,
                destination,
                card,
              });
            }
        } else if (
          ["running", "leased", "queued"].includes(run.status) &&
          Date.now() - origin.createdAt.getTime() >= 180_000
        ) {
          await enqueueChat(prisma, {
            key: `progress:${origin.taskId}`,
            taskId: origin.taskId,
            installationId: installation.id,
            destination,
            card: { text: "Still working." },
          });
        }
      }
    },
  };
}
function asks(blocks: unknown) {
  return (Array.isArray(blocks) ? (blocks as MessageBlock[]) : []).filter(
    (block): block is Extract<MessageBlock, { kind: "ask" }> =>
      block.kind === "ask" && block.status !== "answered",
  );
}
