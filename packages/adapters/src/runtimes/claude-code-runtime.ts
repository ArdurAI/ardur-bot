import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
} from "@ardurbot/adapter-kit";
import type { RuntimeAvailability, RuntimePin } from "@ardurbot/contracts";
import { RuntimePinError, runtimePinProblem } from "@ardurbot/contracts";
import { listPiCatalog } from "../pi-models.js";
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

export function claudeModels(): RuntimeAvailability["models"] {
  // Higher effort can be silently capped by organization policy in stream-json.
  // Only the lowest documented effort is currently attestable without reading vendor auth.
  return listPiCatalog()
    .filter(
      (model) =>
        model.provider === "anthropic" &&
        /^(claude-(?:opus-(?:5(?:-5)?|4-[678])|sonnet-(?:5|4-6)|fable-5(?:-1)?))(?:-\d{8})?$/.test(
          model.id,
        ) &&
        model.thinkingLevels?.includes("low") &&
        !model.placeholder,
    )
    .map((model) => ({ id: model.id, label: model.label, efforts: ["low"] }));
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
    const parts = version.split(".").map(Number);
    if (parts[0] !== 2 || parts[1] !== 1 || parts[2]! < 259)
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
    JSON.stringify({ disableAllHooks: true, switchModelsOnFlag: false, fallbackModel: [] }),
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
  parse(value: Record<string, unknown>): AgentRuntimeEvent[] {
    if (value.type === "system" && value.subtype === "init") {
      this.model(value.model);
      assertClaudeTools(value.tools, this.pin);
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
      return [{ type: "done" }];
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
    if (pin?.runtimeKind !== "claude-code" || pin.effort !== "low")
      throw new RuntimePinError(
        runtimePinProblem(
          pin,
          "pin-effort-unsupported",
          "Claude Code cannot attest higher effort in stream-json; change the pin.",
        ),
      );
    const binary = await findNativeBinary("claude");
    if (!binary)
      throw new RuntimePinError(
        runtimePinProblem(pin, "runtime-unavailable", "claude is not installed on this computer"),
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
    const abort = () => {
      queue.end();
      child?.kill("SIGTERM");
    };
    let reader: Promise<void> | undefined;
    try {
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
            if (value.type === "system" && parser.initialized)
              await request.onRuntimeInfo?.({
                runtimeKind: "claude-code",
                sessionId: parser.sessionId ?? sessionId,
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
          queue.end(
            error instanceof RuntimePinError
              ? error
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
