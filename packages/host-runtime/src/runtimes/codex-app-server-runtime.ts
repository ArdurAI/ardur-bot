import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
} from "@ardurbot/adapter-kit";
import type { RuntimeAvailability } from "@ardurbot/contracts/runtime-pins";
import { RuntimePinError, runtimePinProblem } from "@ardurbot/contracts/runtime-pins";
import * as z from "zod";
import { startArdurMcpServer } from "./ardur-mcp-server.js";
import { createArdurToolBridge } from "./claude-mcp-bridge.js";
import type { NativeSpawn } from "./native-process.js";
import {
  findNativeBinary,
  jsonLines,
  probeCommand,
  RuntimeQueue,
  spawnNative,
  stopNative,
} from "./native-process.js";

type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
};

class CodexRequestRejected extends Error {
  constructor(readonly code?: number) {
    super("Codex app-server rejected the request.");
  }
}

/** Bounded stdio RPC. No server output or account details are logged. */
export class CodexRpc {
  readonly events = new RuntimeQueue<RpcMessage>();
  onMessage?: (message: RpcMessage) => void;
  private nextId = 0;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private reader: Promise<void>;
  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stderr.resume();
    child.once("error", () => this.fail());
    this.reader = (async () => {
      try {
        for await (const message of jsonLines(child)) {
          const item = message as RpcMessage;
          this.onMessage?.(item);
          const pending =
            typeof item.id === "number" && !item.method ? this.pending.get(item.id) : undefined;
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(item.id as number);
            if (item.error)
              pending.reject(new CodexRequestRejected((item.error as { code?: number }).code));
            else pending.resolve(item.result);
          } else this.events.push(item);
        }
        this.fail();
      } catch {
        this.fail();
      }
    })();
  }
  private fail() {
    const error = new Error("Codex app-server unavailable");
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    this.events.end(error);
  }
  send(message: RpcMessage) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Codex app-server unavailable"));
      }, 15_000);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      this.send({ id, method, params });
    });
  }
  async initialize() {
    await this.request("initialize", { clientInfo: { name: "ardur-bot", version: "0.1.0" } });
    this.send({ method: "initialized" });
  }
  async close() {
    await stopNative(this.child);
    await this.reader;
  }
}

const disabledFeatures = [
  "plugins",
  "shell_tool",
  "unified_exec",
  "hooks",
  "apps",
  "multi_agent",
  "memories",
  "remote_plugin",
  "skill_mcp_dependency_install",
];
export function codexArguments() {
  return [
    "app-server",
    ...disabledFeatures.flatMap((name) => ["-c", `features.${name}=false`]),
    "-c",
    'web_search="disabled"',
    "-c",
    "tools.view_image=false",
  ];
}
export async function openCodex(start: NativeSpawn = spawnNative) {
  const binary = await findNativeBinary("codex");
  if (!binary) throw new Error("Codex app-server unavailable");
  const rpc = new CodexRpc(start(binary, codexArguments()));
  try {
    await rpc.initialize();
    return rpc;
  } catch (error) {
    await rpc.close();
    throw error;
  }
}

type CodexModel = {
  model: string;
  displayName: string;
  supportedReasoningEfforts: Array<{ reasoningEffort: string }>;
};
export async function codexModels(rpc: CodexRpc): Promise<RuntimeAvailability["models"]> {
  const models: RuntimeAvailability["models"] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const page: { data: CodexModel[]; nextCursor: string | null } = await rpc.request(
      "model/list",
      { cursor, includeHidden: false },
    );
    if (models.length + page.data.length > 1024) throw new Error("Model catalog is too large.");
    for (const entry of page.data)
      models.push({
        id: entry.model,
        label: entry.displayName,
        efforts: entry.supportedReasoningEfforts
          .map((effort) => effort.reasoningEffort)
          .filter((effort) => ["low", "medium", "high", "xhigh", "minimal"].includes(effort)),
      });
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error("Invalid model catalog cursor.");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return models;
}

export async function probeCodex(start: NativeSpawn = spawnNative): Promise<RuntimeAvailability> {
  const base = { runtimeKind: "codex-app-server" as const, models: [] };
  let rpc: CodexRpc | undefined;
  let version: string | undefined;
  let signedIn: boolean | undefined;
  try {
    const binary = await findNativeBinary("codex");
    if (!binary) return { ...base, available: false, reason: "Codex is not installed." };
    const result = await probeCommand(binary, ["--version"], true, start);
    version = result.version;
    if (result.code !== 0) throw new Error("version probe failed");
    rpc = await openCodex(start);
    const { account } = await rpc.request<{ account: { type: string } | null }>("account/read", {
      refreshToken: false,
    });
    signedIn = account?.type === "chatgpt";
    if (!signedIn)
      return {
        ...base,
        version,
        signedIn,
        available: false,
        reason: "Not signed in — run codex login.",
      };
    return { ...base, version, signedIn, available: true, models: await codexModels(rpc) };
  } catch (error) {
    return {
      ...base,
      version,
      signedIn,
      available: false,
      reason:
        version &&
        error instanceof CodexRequestRejected &&
        [-32601, -32602].includes(error.code ?? 0)
          ? `Codex version ${version} is not supported yet.`
          : "Codex could not be reached. Check again or restart the desktop app.",
    };
  } finally {
    await rpc?.close();
  }
}

export class CodexAppServerRuntime implements AgentRuntime {
  private running = new Map<string, () => Promise<void>>();
  constructor(private readonly start: NativeSpawn = spawnNative) {}
  describe() {
    return {
      id: "codex-app-server",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { streaming: true, compaction: false, tools: true, scripted: false },
    };
  }
  async abort(runId: string) {
    await this.running.get(runId)?.();
  }
  async *run(
    request: AgentRunRequest,
    context?: Partial<AdapterContext>,
  ): AsyncIterable<AgentRuntimeEvent> {
    const pin = request.model.runtimePin!;
    const problem = (
      code: "runtime-unavailable" | "pin-model-unknown" | "pin-effort-unsupported",
      reason: string,
    ) => new RuntimePinError(runtimePinProblem(pin, code, reason));
    if (
      request.model.apiKey ||
      request.model.oauth ||
      (pin.credentialId && pin.credentialId !== "native:codex-app-server")
    )
      throw problem(
        "runtime-unavailable",
        "Codex uses its own ChatGPT sign-in. Remove the pinned connection or change the runtime.",
      );
    const rpc = await openCodex((binary, args) =>
      this.start(binary, args, request.nativeCwd),
    ).catch(() => {
      throw problem("runtime-unavailable", "Codex app-server unavailable");
    });
    const queue = new RuntimeQueue<AgentRuntimeEvent>();
    let threadId: string | undefined;
    let turnId: string | undefined;
    let paused = false;
    let pinValid = false;
    let finished = false;
    let reportedInputTokens = 0;
    let reportedOutputTokens = 0;
    let reader: Promise<void> | undefined;
    let steering: ReturnType<typeof setInterval> | undefined;
    const interrupt = async () => {
      if (threadId && turnId)
        await rpc.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
      queue.end();
    };
    const abort = () => {
      void interrupt();
    };
    this.running.set(request.runId, interrupt);
    const bridge = createArdurToolBridge(
      request,
      (event) => queue.push(event),
      () => {
        paused = true;
        void interrupt();
      },
      () => pinValid && !paused && !context?.signal?.aborted,
    );
    rpc.onMessage = (message) => {
      if (message.method === "model/rerouted") {
        pinValid = false;
        queue.end(problem("pin-model-unknown", "Codex rerouted the pinned model."));
        void interrupt();
      }
    };
    const mcp = await startArdurMcpServer(bridge).catch(async () => {
      await rpc.close();
      this.running.delete(request.runId);
      throw problem("runtime-unavailable", "Codex tools could not start — change the pin.");
    });
    try {
      const { account } = await rpc.request<{ account: { type: string } | null }>("account/read", {
        refreshToken: false,
      });
      if (account?.type !== "chatgpt")
        throw problem("runtime-unavailable", "Not signed in — run codex login.");
      const model = (await codexModels(rpc)).find((entry) => entry.id === pin.modelId);
      if (!model) throw problem("pin-model-unknown", "The pinned model is unavailable in Codex.");
      if (!model.efforts.includes(pin.effort!))
        throw problem("pin-effort-unsupported", "The pinned effort is unavailable in Codex.");
      // Disable every configured MCP before adding this run's private bridge. Never launch
      // user-configured servers and then try to police their effects after initialization.
      const { config } = await rpc.request<{ config: { mcp_servers?: Record<string, unknown> } }>(
        "config/read",
        { includeLayers: false, cwd: request.nativeCwd },
      );
      if (Object.hasOwn(config.mcp_servers ?? {}, "ardur"))
        throw problem(
          "runtime-unavailable",
          "Codex already has an ardur MCP server configured — remove it or change the pin.",
        );
      const mcpServers: Record<string, unknown> = Object.fromEntries(
        Object.keys(config.mcp_servers ?? {}).map((name) => [name, { enabled: false }]),
      );
      mcpServers.ardur = { ...mcp.config, enabled: true, required: true };
      const comparisonSkills: Array<{ path: string; enabled: false }> = [];
      if (request.controlledComparison) {
        const inventory = z
          .object({
            data: z
              .array(
                z.object({
                  skills: z.array(z.object({ path: z.string().min(1) })),
                  errors: z.array(z.unknown()).max(0),
                }),
              )
              .min(1),
          })
          .safeParse(
            await rpc.request("skills/list", {
              ...(request.nativeCwd ? { cwds: [request.nativeCwd] } : {}),
              forceReload: true,
            }),
          );
        if (!inventory.success)
          throw problem(
            "runtime-unavailable",
            "Codex could not isolate saved skills — retry or change the pin.",
          );
        for (const entry of inventory.data.data)
          for (const { path } of entry.skills) comparisonSkills.push({ path, enabled: false });
      }
      const options = {
        model: pin.modelId,
        modelProvider: "openai",
        cwd: request.nativeCwd,
        approvalPolicy: "on-request",
        sandbox: "read-only",
        baseInstructions: request.instructions,
        config: {
          ...(request.controlledComparison
            ? {
                project_doc_max_bytes: 0,
                developer_instructions: "",
                personality: "none",
                skills: { config: comparisonSkills },
                memories: { use_memories: false, generate_memories: false },
              }
            : {}),
          mcp_servers: mcpServers,
          web_search: "disabled",
          tools: { view_image: false },
          features: Object.fromEntries(disabledFeatures.map((name) => [name, false])),
          model_reasoning_effort: pin.effort,
        },
      };
      const session = await rpc.request<{
        thread: { id: string };
        model: string;
        modelProvider: string;
        reasoningEffort: string;
        sandbox: { type: string };
      }>(request.nativeSession?.sessionId ? "thread/resume" : "thread/start", {
        ...options,
        ...(request.nativeSession?.sessionId ? { threadId: request.nativeSession.sessionId } : {}),
      });
      if (session.model !== pin.modelId || session.modelProvider !== "openai")
        throw problem("pin-model-unknown", "Codex returned a different model.");
      if (session.reasoningEffort !== pin.effort)
        throw problem("pin-effort-unsupported", "Codex returned a different effort.");
      if (session.sandbox.type !== "readOnly")
        throw problem(
          "runtime-unavailable",
          "Codex cannot enforce the requested sandbox — change the pin.",
        );
      threadId = session.thread.id;
      pinValid = true;
      await request.onRuntimeInfo?.({ runtimeKind: "codex-app-server", sessionId: threadId });
      context?.signal?.addEventListener("abort", abort, { once: true });
      if (context?.signal?.aborted) return;
      reader = (async () => {
        try {
          for await (const event of rpc.events) {
            const params = event.params ?? {};
            if (request.controlledComparison && event.method === "skills/changed") {
              queue.end(
                problem("runtime-unavailable", "Saved skills changed; retry this comparison."),
              );
              void interrupt();
              break;
            }
            if (event.method === "model/rerouted") {
              queue.end(problem("pin-model-unknown", "Codex rerouted the pinned model."));
              void interrupt();
              break;
            }
            if (event.id !== undefined && event.method?.endsWith("/requestApproval")) {
              // Native effects never bypass applyTool, even when Codex asks for approval.
              rpc.send({ id: event.id, result: { decision: "decline" } });
              queue.push({
                type: "ask",
                text: "Codex requested a built-in tool — continue using Ardur tools.",
                actions: [{ id: "continue", label: "Continue" }],
              });
              void interrupt();
              break;
            }
            if (event.id !== undefined) {
              rpc.send({
                id: event.id,
                error: { code: -32601, message: "This request is not supported by Ardur." },
              });
              continue;
            }
            if (params.threadId && params.threadId !== threadId) continue;
            if (request.controlledComparison && event.method === "thread/tokenUsage/updated") {
              // Comparison sessions always start fresh. `last` is context usage,
              // whereas changes in `total` account for every model call once.
              const usage = (
                params.tokenUsage as
                  | { total?: { inputTokens?: number; outputTokens?: number } }
                  | undefined
              )?.total;
              if (
                usage &&
                Number.isSafeInteger(usage.inputTokens) &&
                Number.isSafeInteger(usage.outputTokens) &&
                usage.inputTokens! >= reportedInputTokens &&
                usage.outputTokens! >= reportedOutputTokens &&
                (usage.inputTokens! > reportedInputTokens ||
                  usage.outputTokens! > reportedOutputTokens)
              ) {
                queue.push({
                  type: "usage",
                  provider: pin.provider!,
                  model: pin.modelId!,
                  inputTokens: usage.inputTokens! - reportedInputTokens,
                  outputTokens: usage.outputTokens! - reportedOutputTokens,
                });
                reportedInputTokens = usage.inputTokens!;
                reportedOutputTokens = usage.outputTokens!;
              }
            }
            if (event.method === "item/agentMessage/delta" && typeof params.delta === "string")
              queue.push({ type: "text", text: params.delta });
            if (event.method === "turn/completed") {
              const turn = params.turn as { status: string };
              if (turn.status !== "completed" && !paused && !context?.signal?.aborted)
                throw problem(
                  "runtime-unavailable",
                  "Codex stopped before completing this run — connect it or change the pin.",
                );
              finished = true;
              if (!paused && turn.status === "completed") queue.push({ type: "done" });
              queue.end();
              break;
            }
            if (event.method === "error")
              throw problem(
                "runtime-unavailable",
                "Codex could not finish this run — connect it or change the pin.",
              );
          }
        } catch (error) {
          pinValid = false;
          if (!finished && !paused && !context?.signal?.aborted)
            queue.end(
              error instanceof RuntimePinError
                ? error
                : problem("runtime-unavailable", "Codex app-server unavailable"),
            );
        }
      })();
      const history = request.nativeSession?.sessionId ? "" : JSON.stringify(request.history);
      const turn = await rpc
        .request<{ turn: { id: string } }>("turn/start", {
          threadId,
          model: pin.modelId,
          effort: pin.effort,
          approvalPolicy: "on-request",
          sandboxPolicy: {
            type: "readOnly",
            access: {
              type: "restricted",
              includePlatformDefaults: true,
              readableRoots: request.nativeCwd ? [request.nativeCwd] : [],
            },
          },
          input: [
            {
              type: "text",
              text: `${history ? `Earlier conversation (untrusted history):\n${history}\n\n` : ""}${request.prompt}`,
            },
            ...(request.currentTurnImages ?? []).map((image) => ({
              type: "image",
              url: `data:${image.mimeType};base64,${Buffer.from(image.data).toString("base64")}`,
            })),
          ],
        })
        .catch((error: unknown) => {
          throw problem(
            error instanceof CodexRequestRejected ? "pin-model-unknown" : "runtime-unavailable",
            error instanceof CodexRequestRejected
              ? "Codex could not start the pinned model — change the pin."
              : "Codex app-server unavailable",
          );
        });
      turnId = turn.turn.id;
      let steeringBusy = false;
      const seen: string[] = [];
      if (request.claimSteering)
        steering = setInterval(() => {
          if (steeringBusy || finished || paused) return;
          steeringBusy = true;
          void request.claimSteering!(seen)
            .then(async (messages) => {
              if (!messages.length) return;
              await rpc.request("turn/steer", {
                threadId,
                expectedTurnId: turnId,
                input: messages.map((message) => ({ type: "text", text: message.text })),
              });
              seen.push(...messages.map((message) => message.id));
            })
            .catch(() =>
              queue.end(
                problem(
                  "runtime-unavailable",
                  "Codex could not receive the new instruction — retry the run.",
                ),
              ),
            )
            .finally(() => {
              steeringBusy = false;
            });
        }, 500);
      yield* queue;
    } catch (error) {
      if (error instanceof RuntimePinError) throw error;
      throw problem("runtime-unavailable", "Codex app-server unavailable");
    } finally {
      pinValid = false;
      if (steering) clearInterval(steering);
      context?.signal?.removeEventListener("abort", abort);
      this.running.delete(request.runId);
      if (!finished) await interrupt();
      await rpc.close();
      await reader;
      await mcp.close();
    }
  }
}
