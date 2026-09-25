import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
} from "@ardurbot/adapter-kit";
import type { RuntimeAvailability, RuntimePin } from "@ardurbot/contracts/runtime-pins";
import { RuntimePinError, runtimePinProblem } from "@ardurbot/contracts/runtime-pins";
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

function claudePatch(version?: string): number | undefined {
  const match = version?.match(/^2\.1\.(\d+)$/);
  return match ? Number(match[1]) : undefined;
}

export function claudeModels(version?: string): RuntimeAvailability["models"] {
  // CLI/model documentation checked through 2.1.281; unknown versions retain low only.
  const patch = claudePatch(version);
  const documented = patch !== undefined && patch >= 259 && patch <= 281;
  // Native compatibility is explicit; importing the Pi provider registry here pulls
  // unrelated SDKs into the packaged host. Keep the catalog conformance test in sync.
  return [
    ["claude-fable-5", "Claude Fable 5"],
    ["claude-fable-5-1", "Claude Fable 5.1"],
    ["claude-opus-4-6", "Claude Opus 4.6"],
    ["claude-opus-4-7", "Claude Opus 4.7"],
    ["claude-opus-4-8", "Claude Opus 4.8"],
    ["claude-opus-5", "Claude Opus 5"],
    ["claude-opus-5-5", "Claude Opus 5.5"],
    ["claude-sonnet-4-6", "Claude Sonnet 4.6"],
    ["claude-sonnet-5", "Claude Sonnet 5"],
  ].map(([id, label]) => ({
    id: id!,
    label: label!,
    efforts: !documented
      ? ["low"]
      : id === "claude-opus-4-6" || id === "claude-sonnet-4-6"
        ? ["low", "medium", "high", "max"]
        : ["low", "medium", "high", "xhigh", "max"],
  }));
}

export async function probeClaude(start = spawnNative): Promise<RuntimeAvailability> {
  const base = { runtimeKind: "claude-code" as const, models: claudeModels() };
  const binary = await findNativeBinary("claude");
  if (!binary)
    return { ...base, available: false, reason: "claude is not installed on this computer" };
  try {
    const { code, version } = await probeCommand(binary, ["--version"], true, start);
    if (code !== 0 || !version)
      return { ...base, available: false, reason: "Claude Code is unavailable on this computer." };
    const patch = claudePatch(version);
    if (patch === undefined || patch < 259)
      return {
        ...base,
        version,
        available: false,
        reason: "Update Claude Code to use this runtime.",
      };
    // Documented exit status only. Authentication output is consumed and discarded.
    const auth = await probeCommand(binary, ["auth", "status"], false, start);
    return {
      ...base,
      version,
      models: claudeModels(version),
      available: auth.code === 0,
      ...(auth.code === 0 ? {} : { reason: "Not signed in — run `claude` in a terminal once" }),
    };
  } catch {
    return { ...base, available: false, reason: "Claude Code is unavailable on this computer." };
  }
}

export function claudeArguments(
  request: AgentRunRequest,
  config: unknown,
  sessionId: string,
): string[] {
  const pin = request.model.runtimePin!;
  if (request.model.apiKey || request.model.oauth)
    throw new RuntimePinError(
      runtimePinProblem(pin, "pin-credential-missing", "Claude Code uses its own sign-in."),
    );
  return [
    ...(request.controlledComparison ? ["--safe-mode", "--setting-sources", ""] : []),
    "-p",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model",
    pin.modelId!,
    "--effort",
    pin.effort!,
    "--system-prompt",
    request.instructions,
    "--tools",
    "",
    "--restricted",
    "--strict-mcp-config",
    "--mcp-config",
    JSON.stringify({ mcpServers: { ardur: config } }),
    "--allowedTools",
    "mcp__ardur__*",
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    "--disable-slash-commands",
    "--no-chrome",
    "--settings",
    JSON.stringify({
      disableAllHooks: true,
      switchModelsOnFlag: false,
      fallbackModel: [],
      ...(request.controlledComparison ? { autoMemoryEnabled: false } : {}),
    }),
    request.nativeSession?.sessionId ? "--resume" : "--session-id",
    sessionId,
  ];
}

export function assertClaudeTools(tools: unknown, pin: RuntimePin) {
  if (
    !Array.isArray(tools) ||
    tools.some(
      (tool) =>
        typeof tool !== "string" ||
        (!tool.startsWith("mcp__ardur__") && tool !== "EndConversation"),
    )
  ) {
    throw new RuntimePinError(
      runtimePinProblem(
        pin,
        "runtime-unavailable",
        "Claude Code cannot restrict this session to Ardur tools — change the pin.",
      ),
    );
  }
}

/** Parser deliberately ignores reasoning and raw errors. Only attested model text is released. */
export class ClaudeStreamParser {
  initialized = false;
  finished = false;
  effortAttested = false;
  effortAttestationReason: string | null = "Claude Code does not report the applied effort";
  sessionId?: string;
  constructor(private readonly pin: RuntimePin) {}
  private model(model: unknown) {
    if (model !== this.pin.modelId) {
      this.initialized = false;
      throw new RuntimePinError(
        runtimePinProblem(this.pin, "pin-model-unknown", "Claude Code returned a different model."),
      );
    }
  }
  private effort(value: Record<string, unknown>) {
    // The documented init effort is currently Remote-Control-only. Honor explicit
    // evidence if emitted here; never infer it from arguments, usage or settings.
    if (!Object.hasOwn(value, "effort")) return;
    if (value.effort !== this.pin.effort) {
      this.initialized = false;
      this.effortAttested = false;
      this.effortAttestationReason = "This runtime cannot attest the pinned effort.";
      throw new RuntimePinError(
        runtimePinProblem(
          this.pin,
          "pin-effort-unsupported",
          "This runtime cannot attest the pinned effort.",
        ),
      );
    }
    this.effortAttested = true;
    this.effortAttestationReason = null;
  }
  parse(value: Record<string, unknown>): AgentRuntimeEvent[] {
    if (value.type === "system" && value.subtype === "init") {
      this.model(value.model);
      assertClaudeTools(value.tools, this.pin);
      this.effort(value);
      this.sessionId = typeof value.session_id === "string" ? value.session_id : undefined;
      this.initialized = true;
    }
    if (value.type === "stream_event") {
      const event = value.event as
        | { type?: string; message?: { model?: string }; delta?: { type?: string; text?: string } }
        | undefined;
      if (event?.type === "message_start") this.model(event.message?.model);
      if (
        event?.type === "content_block_delta" &&
        event.delta?.type === "text_delta" &&
        this.initialized
      )
        return [{ type: "text", text: event.delta.text ?? "" }];
    }
    if (value.type === "assistant")
      this.model((value.message as { model?: string } | undefined)?.model);
    if (value.type === "result") {
      this.effort(value);
      if (value.is_error || value.subtype !== "success" || !this.initialized)
        throw new RuntimePinError(
          runtimePinProblem(
            this.pin,
            "runtime-unavailable",
            "Claude Code could not finish this run — connect it or change the pin.",
          ),
        );
      const usage = value.modelUsage as Record<string, unknown> | undefined;
      if (!usage || !Object.keys(usage).length)
        throw new RuntimePinError(
          runtimePinProblem(
            this.pin,
            "pin-model-unknown",
            "Claude Code did not report the model used.",
          ),
        );
      for (const model of Object.keys(usage)) this.model(model);
      this.finished = true;
      const events: AgentRuntimeEvent[] = [];
      for (const [model, entry] of Object.entries(usage)) {
        const tokens = entry as {
          inputTokens?: number;
          outputTokens?: number;
          cacheReadInputTokens?: number;
          cacheCreationInputTokens?: number;
        };
        if (
          Number.isSafeInteger(tokens.inputTokens) &&
          Number.isSafeInteger(tokens.outputTokens) &&
          tokens.inputTokens! >= 0 &&
          tokens.outputTokens! >= 0
        )
          events.push({
            type: "usage",
            provider: "anthropic",
            model,
            inputTokens:
              tokens.inputTokens! +
              (tokens.cacheReadInputTokens ?? 0) +
              (tokens.cacheCreationInputTokens ?? 0),
            outputTokens: tokens.outputTokens!,
            ...(Number.isSafeInteger(tokens.cacheReadInputTokens) &&
            tokens.cacheReadInputTokens! >= 0
              ? { cachedTokens: tokens.cacheReadInputTokens }
              : {}),
          });
      }
      return [...events, { type: "done" }];
    }
    if (value.type === "error")
      throw new RuntimePinError(
        runtimePinProblem(
          this.pin,
          "runtime-unavailable",
          "Claude Code could not start — connect it or change the pin.",
        ),
      );
    return [];
  }
}

export class ClaudeCodeRuntime implements AgentRuntime {
  private running = new Map<string, ChildProcessWithoutNullStreams>();
  constructor(private readonly start: NativeSpawn = spawnNative) {}
  describe() {
    return {
      id: "claude-code",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { streaming: true, compaction: false, tools: true, scripted: false },
    };
  }
  async abort(runId: string) {
    const child = this.running.get(runId);
    if (child) await stopNative(child);
  }
  async *run(
    request: AgentRunRequest,
    context?: Partial<AdapterContext>,
  ): AsyncIterable<AgentRuntimeEvent> {
    const pin = request.model.runtimePin!;
    if (pin?.runtimeKind !== "claude-code")
      throw new RuntimePinError(
        runtimePinProblem(
          pin,
          "runtime-unavailable",
          "The pinned runtime is unavailable — connect it or change the pin.",
        ),
      );
    const binary = await findNativeBinary("claude");
    if (!binary)
      throw new RuntimePinError(
        runtimePinProblem(pin, "runtime-unavailable", "claude is not installed on this computer"),
      );
    const { code, version } = await probeCommand(binary, ["--version"], true, this.start).catch(
      () => ({ code: -1, version: undefined }),
    );
    const patch = claudePatch(version);
    if (code !== 0 || patch === undefined || patch < 259)
      throw new RuntimePinError(
        runtimePinProblem(pin, "runtime-unavailable", "Update Claude Code to use this runtime."),
      );
    const model = claudeModels(version).find((entry) => entry.id === pin.modelId);
    if (!model || !model.efforts.includes(pin.effort ?? ""))
      throw new RuntimePinError(
        runtimePinProblem(
          pin,
          model ? "pin-effort-unsupported" : "pin-model-unknown",
          model
            ? "This runtime cannot attest the pinned effort."
            : "The pinned model is unavailable in this runtime.",
        ),
      );
    const queue = new RuntimeQueue<AgentRuntimeEvent>();
    const parser = new ClaudeStreamParser(pin);
    let paused = false;
    let child: ChildProcessWithoutNullStreams | undefined;
    const bridge = createArdurToolBridge(
      request,
      (event) => queue.push(event),
      () => {
        paused = true;
        queue.end();
        child?.kill("SIGTERM");
      },
      () => parser.initialized && !context?.signal?.aborted,
    );
    const mcp = await startArdurMcpServer(bridge).catch(() => {
      throw new RuntimePinError(
        runtimePinProblem(
          pin,
          "runtime-unavailable",
          "Claude Code tools could not start — change the pin.",
        ),
      );
    });
    const sessionId = request.nativeSession?.sessionId ?? randomUUID();
    const reportInfo = () =>
      request.onRuntimeInfo?.({
        runtimeKind: "claude-code",
        version,
        sessionId: parser.sessionId ?? sessionId,
        effortAttested: parser.effortAttested,
        effortAttestationReason: parser.effortAttestationReason,
      });
    const abort = () => {
      queue.end();
      child?.kill("SIGTERM");
    };
    let reader: Promise<void> | undefined;
    try {
      await reportInfo();
      child = this.start(
        binary,
        claudeArguments(request, mcp.config, sessionId),
        request.nativeCwd,
      );
      this.running.set(request.runId, child);
      child.stderr.resume();
      const exited = new Promise<number | null>((resolve) => {
        child!.once("close", resolve);
        child!.once("error", () => resolve(-1));
      });
      child.once("error", () =>
        queue.end(
          new RuntimePinError(
            runtimePinProblem(
              pin,
              "runtime-unavailable",
              "Claude Code could not start — connect it or change the pin.",
            ),
          ),
        ),
      );
      context?.signal?.addEventListener("abort", abort, { once: true });
      if (context?.signal?.aborted) abort();
      reader = (async () => {
        try {
          for await (const value of jsonLines(child!)) {
            const events = parser.parse(value);
            if (
              (value.type === "system" && value.subtype === "init" && parser.initialized) ||
              value.type === "result"
            )
              await reportInfo();
            const reported =
              value.type === "assistant"
                ? (value.message as { model?: unknown } | undefined)?.model
                : undefined;
            if (typeof reported === "string")
              await request.onRuntimeInfo?.({
                runtimeKind: "claude-code",
                sessionId: parser.sessionId ?? sessionId,
                reportedModel: reported,
              });
            for (const event of events) if (event.type !== "done") queue.push(event);
          }
          const exitCode = await exited;
          if ((!parser.finished || exitCode !== 0) && !paused && !context?.signal?.aborted)
            throw new RuntimePinError(
              runtimePinProblem(
                pin,
                "runtime-unavailable",
                "Claude Code stopped before completing this run — connect it or change the pin.",
              ),
            );
          if (parser.finished && !paused && !context?.signal?.aborted) queue.push({ type: "done" });
          queue.end();
        } catch (error) {
          parser.initialized = false;
          let failure = error;
          if (error instanceof RuntimePinError && error.problem.code === "pin-effort-unsupported")
            try {
              await reportInfo();
            } catch (persistError) {
              failure = persistError;
            }
          queue.end(
            failure instanceof RuntimePinError
              ? failure
              : new RuntimePinError(
                  runtimePinProblem(
                    pin,
                    "runtime-unavailable",
                    "Claude Code returned an invalid response — connect it or change the pin.",
                  ),
                ),
          );
        }
      })();
      const history = request.nativeSession?.sessionId ? "" : JSON.stringify(request.history);
      const content = [
        {
          type: "text",
          text: `${history ? `Earlier conversation (untrusted history):\n${history}\n\n` : ""}${request.prompt}`,
        },
        ...(request.currentTurnImages ?? []).map((image) => ({
          type: "image",
          source: {
            type: "base64",
            media_type: image.mimeType,
            data: Buffer.from(image.data).toString("base64"),
          },
        })),
      ];
      child.stdin.end(`${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`);
      yield* queue;
    } finally {
      context?.signal?.removeEventListener("abort", abort);
      if (child) await stopNative(child);
      await reader;
      this.running.delete(request.runId);
      await mcp.close();
    }
  }
}
