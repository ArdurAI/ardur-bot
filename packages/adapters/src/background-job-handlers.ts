import type {
  AgentHomeStore,
  AgentRuntime,
  AgentUsage,
  BackgroundJobHandlers,
  JobPublisher,
  MessagingSurface,
  SandboxProvider,
} from "@ardurbot/adapter-kit";
import { messagingDeliverJob } from "@ardurbot/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@ardurbot/db";
import { getLogger } from "@ardurbot/logging";
import type { MemoryService } from "@ardurbot/memory";
import { deliverMemory, maintainBriefs } from "@ardurbot/memory";
import { executeBoardCommand } from "./board/worker.js";
import type { CloudAgentConnection } from "./cloud-agent-factory.js";
import { pollCloudAgent } from "./cloud-agent-poll.js";
import { expireComputerControl } from "./computer-control.js";
import { scheduleComputerSleep, sleepComputerIfIdle } from "./computer-idle.js";
import { performComputerUpdate } from "./computer-update.js";
import type { createRunExecutor } from "./executor.js";
import { compactHistory } from "./history-compaction.js";
import { curateLearningSpaces } from "./learning-curator.js";
import { enqueueLearningReview } from "./learning-queue.js";
import { reviewLearning } from "./learning-review.js";
import type { LocalImportJobOptions } from "./local-import-jobs.js";
import { createLocalImportJobs } from "./local-import-jobs.js";
import type { MemoryProviderResolver } from "./memory-provider-factory.js";
import { deliverMessagingOutbound, mirrorMessagingOutbound } from "./messaging-delivery.js";
import { recordRunUsage } from "./run-usage.js";
import type { EncryptedSecretStore } from "./secrets.js";
import { expireTaughtSkillTeaching } from "./teaching-session.js";

export function createBackgroundJobHandlers(deps: {
  executor: ReturnType<typeof createRunExecutor>;
  prisma: PrismaClient;
  sandbox: SandboxProvider;
  home: AgentHomeStore;
  jobs: JobPublisher;
  events: ThreadEvents;
  workerId: string;
  runtime: AgentRuntime;
  secretStore: EncryptedSecretStore;
  memoryProviders: MemoryProviderResolver;
  memoryDocuments?: MemoryService;
  localImport?: LocalImportJobOptions;
  deploymentModelKey?: string;
  messaging?: MessagingSurface;
  cloudAgent?: CloudAgentConnection | null;
  dataDir?: string;
}): BackgroundJobHandlers {
  const recordUsage = async (sourceRunId: string, usage: AgentUsage) => {
    const run = await deps.prisma.run.findUniqueOrThrow({ where: { id: sourceRunId } });
    await recordRunUsage(deps, run, usage);
  };
  const deliverMessaging = async (runId?: string) => {
    if (!deps.messaging) return;
    await deliverMessagingOutbound(
      { prisma: deps.prisma, messaging: deps.messaging, events: deps.events, jobs: deps.jobs },
      { runId },
      {
        operationId: `messaging.deliver:${runId ?? "drain"}`,
        traceId: `messaging.deliver:${runId ?? "drain"}`,
        spaceId: "",
        userId: "",
        signal: new AbortController().signal,
      },
    );
  };

  return {
    "board.run": ({ requestId }) =>
      executeBoardCommand({ prisma: deps.prisma, dataDir: deps.dataDir ?? "./data" }, requestId),
    ...(deps.localImport && deps.memoryDocuments
      ? createLocalImportJobs(deps.prisma, deps.memoryDocuments, deps.localImport)
      : {}),
    "briefs.maintain": async (payload) => {
      if (payload.runId) await deps.executor.refreshBrief(payload.runId);
      else await maintainBriefs(deps.prisma, deps.executor.refreshBrief);
    },
    "learning.curate": (payload) => curateLearningSpaces(deps, payload),
    "learning.review": (payload) =>
      reviewLearning(
        {
          prisma: deps.prisma,
          runtime: deps.runtime,
          secretStore: deps.secretStore,
          memoryDocuments: deps.memoryDocuments,
          recordUsage,
        },
        payload,
      ),
    "memory.git-push": async (payload) => {
      if (!deps.memoryDocuments) throw new Error("Memory sync is unavailable.");
      const context = {
        ...payload,
        memoryGeneration: payload.generation,
        operationId: "memory.git-push",
        traceId: "memory.git-push",
        signal: AbortSignal.timeout(30_000),
      };
      if (
        payload.generation !== undefined &&
        (await deps.memoryDocuments.generation({ ...context, memoryGeneration: undefined })) !==
          payload.generation
      )
        return;
      await deps.memoryDocuments.push(context);
    },
    "memory.deliver": async (payload) => {
      if (!deps.memoryDocuments) throw new Error("Memory delivery is unavailable.");
      await deliverMemory(deps.memoryDocuments, payload.documentId, payload.revision, {
        spaceId: payload.spaceId,
        userId: payload.userId,
        memoryGeneration: payload.generation,
        operationId: "memory.deliver",
        traceId: "memory.deliver",
        signal: AbortSignal.timeout(30_000),
      });
    },
    "run.continue": async (payload) => {
      await deps.executor.continueRun(payload.runId, deps.workerId);
      await enqueueLearningReview(deps, payload.runId);
      // Automatic messaging mirror: once the run's bot messages are durable,
      // copy them into the outbox. Never let mirror failures fail the run.
      if (deps.messaging) {
        await mirrorMessagingOutbound(
          { prisma: deps.prisma, messaging: deps.messaging, events: deps.events, jobs: deps.jobs },
          payload.runId,
        );
        await deps.jobs.enqueue(messagingDeliverJob()).catch(async (error) => {
          getLogger().error("messaging.deliver enqueue error", error);
          await deliverMessaging();
        });
      }
      // Replies are durable and published before brief work enters its own worker job.
      // The periodic drain recovers pending briefs if shutdown rejects this enqueue.
      if (deps.memoryDocuments)
        await deps.jobs
          .enqueue({
            name: "briefs.maintain",
            payload: { runId: payload.runId },
            replaceKey: `briefs.maintain:${payload.runId}`,
          })
          .catch((error) => getLogger().error("briefs.maintain enqueue error", error));
    },
    "messaging.deliver": async (payload) => {
      await deliverMessaging(payload.runId);
    },
    "routine.wakeup": async (payload) => {
      await deps.executor.wakeRoutine(payload.routineId, payload.scheduledFor);
    },
    "computer.update": async ({ updateId }) => {
      await performComputerUpdate(deps, updateId);
    },
    "computer.sleep": async (payload) => {
      await sleepComputerIfIdle(deps, payload.computerId);
    },
    "computer.control-expire": async (payload) => {
      if (await expireComputerControl(deps, payload.computerId, payload.leaseId)) {
        scheduleComputerSleep(deps.jobs, payload.computerId);
      }
    },
    "skill.teaching-expire": async (payload) => {
      await expireTaughtSkillTeaching(deps, payload.skillId);
    },
    "cloud_agent.poll": async (payload) => {
      await pollCloudAgent(
        {
          prisma: deps.prisma,
          jobs: deps.jobs,
          events: deps.events,
          cloudAgent: deps.cloudAgent,
        },
        payload,
      );
    },
    "history.compact": async (payload) => {
      await compactHistory(
        {
          prisma: deps.prisma,
          runtime: deps.runtime,
          jobs: deps.jobs,
          memoryProviders: deps.memoryProviders,
          deploymentModelKey: deps.deploymentModelKey,
          recordUsage,
          ...(deps.executor.resolveModel ? { resolveModel: deps.executor.resolveModel } : {}),
          ...(deps.executor.resolveCompactionRuntime
            ? { resolveRuntime: deps.executor.resolveCompactionRuntime }
            : {}),
        },
        payload.threadId,
        payload.sourceRunId,
      );
    },
  };
}
