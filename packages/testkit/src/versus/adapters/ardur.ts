import type { OutcomeObservation } from "../../scoreboard/graders/outcome.js";
import { isOwnedReplayDatabase } from "../../scoreboard/replay/postgres.js";
import type { ProductionApp } from "../../scoreboard/replay/production.js";
import { fixtureRpc, runProductionTask } from "../../scoreboard/replay/production.js";
import type { DepartmentSandbox, DepartmentServices } from "../../scoreboard/replay/services.js";
import { requireValue } from "../budget.js";
import { assertOwnedTrial } from "../isolation.js";
import type { TrialArtifacts, TrialContext, VersusAdapter } from "./types.js";

/** Ordinary API/queue/executor adapter, reusing W0-5's production runner and hidden grader. */
export class ArdurAdapter implements VersusAdapter {
  readonly product = "ardur" as const;
  private context: TrialContext | null = null;
  private observation: OutcomeObservation | null = null;
  private control = new AbortController();
  private handles: ProductionApp | null = null;
  private cookie = "";
  private botId = "";
  private runId: string | null = null;
  private terminal = false;
  private reason = "not-submitted";
  constructor(
    private readonly options: {
      databaseUrl: string;
      dataDir: string;
      services: DepartmentServices;
      sandbox: DepartmentSandbox;
      createApp: () => Promise<ProductionApp>;
      mode: "scripted-provider" | "live";
      preapproveConsent?: boolean;
      connectBroker?: boolean;
      observe?: (handles: ProductionApp, observation: OutcomeObservation) => Promise<void>;
      configure?: (handles: ProductionApp, cookie: string, botId: string) => Promise<void>;
      waiting?: (
        handles: ProductionApp,
        cookie: string,
        botId: string,
        runId: string,
      ) => Promise<void>;
    },
  ) {}
  async inspect() {
    return {
      interface: "ordinary-authenticated-rpc",
      runtime: "pi",
      executor: "production",
      queue: "graphile",
      database: "disposable-postgresql",
      transport: this.options.mode,
      computer: "W0-5-real-files-shell-denied",
      codingQualification: "not-supported-by-file-fixture",
      usage: "W0-3-landed-versus-coverage-unqualified",
      spans: "incomplete-W0-4",
      toolBudget: "broker-only; native pre-effect accounting unqualified",
      descendantBudget: "native collector unqualified",
    };
  }
  async prepare(context: TrialContext) {
    requireValue(!this.context, "Ardur trial already prepared");
    await assertOwnedTrial(context.workspace, context.stateDirectory);
    requireValue(
      isOwnedReplayDatabase(this.options.databaseUrl),
      "Ardur requires a current invocation-owned database lease",
    );
    const database = new URL(this.options.databaseUrl);
    requireValue(
      ["127.0.0.1", "localhost", "[::1]"].includes(database.hostname) &&
        /^\/scoreboard_trial_\d+$/.test(database.pathname),
      "Ardur requires invocation-owned disposable database",
    );
    requireValue(
      this.options.mode === "scripted-provider",
      "Live Ardur computer/auxiliary-route confinement must be qualified before using this fixture adapter",
    );
    this.context = context;
  }
  async submit() {
    const context = this.context;
    requireValue(
      context && !this.terminal && !this.handles && !context.signal.aborted,
      "Ardur trial not ready",
    );
    const externalCancel = () => {
      this.control.abort();
      context.revokeProvider();
    };
    context.signal.addEventListener("abort", externalCancel, { once: true });
    try {
      const result = await runProductionTask({
        task: context.task,
        databaseUrl: this.options.databaseUrl,
        dataDir: this.options.dataDir,
        modelBaseUrl: context.providerUrl,
        services: this.options.services,
        sandbox: this.options.sandbox,
        model: {
          id: context.budget.model.id,
          maxTokens: context.budget.maxOutputTokens,
          contextWindow: context.budget.contextSize,
        },
        createApp: this.options.createApp,
        control: {
          signal: this.control.signal,
          preapproveConsent: this.options.preapproveConsent,
          configure: async (handles, cookie, botId) => {
            this.handles = handles;
            this.cookie = cookie;
            this.botId = botId;
            await fixtureRpc(handles, cookie, "learning/configure", {
              enabled: false,
              consolidationEnabled: false,
              reviewerPin: null,
            });
            // Resolve the fixture computer before the executor freezes its policy.
            await fixtureRpc(handles, cookie, "computer/boot", { botId });
            if (this.options.connectBroker) {
              const server = await fixtureRpc<{ id: string }>(
                handles,
                cookie,
                "mcp/servers/create",
                {
                  slug: "scoreboard",
                  name: "Synthetic task broker",
                  description: "",
                  enabled: true,
                  transport: "streamable_http",
                  endpoint: context.brokerUrl,
                  headers: {},
                },
              );
              await fixtureRpc(handles, cookie, "mcp/servers/tools", { serverId: server.id });
              await fixtureRpc(handles, cookie, "mcp/servers/permissions", {
                serverId: server.id,
                botIds: [botId],
                toolIds: [...context.task.allowedTools],
                spaceToolPolicies: Object.fromEntries(
                  context.task.allowedTools
                    .filter((tool) => tool === "read_file" || tool === "SCOREBOARD_READ")
                    .map((tool) => [tool, "allow"]),
                ),
              });
              await fixtureRpc(handles, cookie, "mcp/assignments/replace", {
                botId,
                assignments: [
                  {
                    serverId: server.id,
                    allowAllTools: false,
                    needsReview: false,
                    allowedTools: [...context.task.allowedTools],
                  },
                ],
              });
            }
            await this.options.configure?.(handles, cookie, botId);
          },
          admitted: async (handles, _cookie, _botId, runId) => {
            this.runId = runId;
            const durable = await handles.prisma.run.findUniqueOrThrow({
              where: { id: runId },
              select: { status: true, taskId: true },
            });
            context.emit("admission", "application-database", {
              runId,
              taskId: durable.taskId,
              status: durable.status,
            });
          },
          waiting: this.options.waiting,
          observed: async (observation) => {
            this.observation = observation;
            context.revokeProvider();
            await this.options.observe?.(this.handles!, observation);
          },
        },
      });
      this.reason = result.productError ?? result.terminal;
      context.emit(
        ["completed", "failed", "cancelled"].includes(result.persistedStatus)
          ? "terminal"
          : "diagnostic",
        "application-database",
        {
          runId: this.runId,
          status: result.persistedStatus,
          harnessOutcome: result.terminal,
          leaseFence: result.leaseFence,
          usage: result.usage,
        },
      );
      for (const name of result.toolNames)
        context.emit("tool-intent", "application-database", {
          name,
          boundary: "persisted-agent-tool-called-event",
          observedAfterRun: true,
          preEffectBudgetAdmission: false,
        });
      for (const effect of this.observation?.effects ?? [])
        context.emit("effect-receipt", "application-database", {
          ...effect,
          layer: "synthetic-fixture-service",
          productPrevention: false,
        });
    } finally {
      context.revokeProvider();
      this.terminal = true;
      this.cookie = "";
      this.handles = null;
      context.signal.removeEventListener("abort", externalCancel);
    }
  }
  async resume(sessionId: string) {
    requireValue(
      sessionId === this.runId && this.handles && !this.terminal,
      "Resume requires this trial's pending run",
    );
    // Continuing after approval is owned by the production answer/effect RPC.
    // Never invent a database transition or start a second independent run.
    requireValue(this.options.waiting, "No qualified approval decision driver");
    await this.options.waiting(this.handles, this.cookie, this.botId, sessionId);
  }
  async answer(messageId: string, answer: string) {
    requireValue(this.handles && this.runId && this.cookie, "No active Ardur input request");
    await fixtureRpc(this.handles, this.cookie, "threads/answer", {
      botId: this.botId,
      runId: this.runId,
      messageId,
      answer,
    });
    this.context!.emit("approval-decision", "application-rpc", {
      runId: this.runId,
      messageId,
      answer,
      layer: "product-rpc",
    });
  }
  async cancel() {
    this.control.abort();
    try {
      if (this.handles && this.cookie && this.botId)
        await fixtureRpc(this.handles, this.cookie, "threads/stop", { botId: this.botId });
    } finally {
      this.context?.revokeProvider();
    }
  }
  async collect(): Promise<TrialArtifacts> {
    requireValue(
      this.terminal && this.observation,
      "No durable Ardur terminal observation collected",
    );
    return {
      observation: this.observation,
      outcomeReason: this.reason,
      sessionId: this.runId,
      userTtft: null,
      userTtftMissingReason: "API-only surface; no packaged client paint collection",
    };
  }
  async destroy() {
    if (!this.terminal) await this.cancel();
  }
}
