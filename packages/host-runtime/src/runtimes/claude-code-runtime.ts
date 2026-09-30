import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
  UsageOutcome,
} from "@ardurbot/adapter-kit";
import { RequestUsageCollector, usageEvent } from "@ardurbot/adapter-kit";
import type { RuntimeAvailability, RuntimePin } from "@ardurbot/contracts/runtime-pins";
import { RuntimePinError, runtimePinProblem } from "@ardurbot/contracts/runtime-pins";
import { captureChildOutput, childProcessLogger } from "../child-output.js";
import { nativeEnvironment } from "../host-environment.js";
import { guardrailConfigFromEnv } from "../host-guardrails.js";
import { environmentSecrets, mcpConfigSecrets } from "../mcp-diagnostics.js";
import { startArdurMcpServer } from "./ardur-mcp-server.js";
import { createArdurToolBridge } from "./claude-mcp-bridge.js";
import {
  nativeFailureCategory,
  nativeFailureDetail,
  nativeFailureProblem,
} from "./native-failure-signals.js";
import type { NativeSpawn } from "./native-process.js";
import {
  findNativeBinary,
  guardedSpawn,
  guardNativeSpawn,
  jsonLines,
  probeCommand,
  RuntimeQueue,
  spawnNative,
  stopNative,
  terminateNative,
} from "./native-process.js";

function supportedClaudeVersion(version?: string) {
  const match = version?.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return false;
  const [, major, minor, patch] = match.map(Number);
  return major! > 2 || (major === 2 && (minor! > 1 || (minor === 1 && patch! >= 259)));
}

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export function parseClaudeEfforts(help: string) {
  const advertised = /--effort\s+<level>[\s\S]{0,240}?\(([^)\r\n]+)\)/.exec(help)?.[1];
  if (!advertised) return ["low"];
  const values = advertised.split(",").map((value) => value.trim());
  const efforts = CLAUDE_EFFORTS.filter((effort) => values.includes(effort));
  return efforts.includes("low") ? efforts : ["low"];
}

export function claudeModels(version?: string, help = ""): RuntimeAvailability["models"] {
  const efforts = supportedClaudeVersion(version) ? parseClaudeEfforts(help) : ["low"];
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
    efforts: efforts.filter(
      (effort) => effort !== "xhigh" || (id !== "claude-opus-4-6" && id !== "claude-sonnet-4-6"),
    ),
  }));
}

export async function probeClaude(start?: NativeSpawn): Promise<RuntimeAvailability> {
  // Callers pass undefined explicitly (a registry refresh). That is the guardrail wrap.
  const launch = start ?? guardedSpawn();
  const base = { runtimeKind: "claude-code" as const, models: claudeModels() };
  const binary = await findNativeBinary("claude");
  if (!binary)
    return { ...base, available: false, reason: "claude is not installed on this computer" };
  try {
    const { code, version } = await probeCommand(binary, ["--version"], true, launch);
    if (code !== 0 || !version)
      return { ...base, available: false, reason: "Claude Code is unavailable on this computer." };
    if (!supportedClaudeVersion(version))
      return {
        ...base,
        version,
        available: false,
        reason: "Update Claude Code to use this runtime.",
      };
    const help = await probeCommand(binary, ["--help"], true, launch);
    const hasEffortLine = help.code === 0 && /--effort\s+<level>/.test(help.output ?? "");
    // Documented exit status only. Authentication output is consumed and discarded.
    const auth = await probeCommand(binary, ["auth", "status"], false, launch);
    return {
      ...base,
      version,
      models: claudeModels(version, help.output),
      available: auth.code === 0,
      ...(auth.code !== 0
        ? { reason: "Not signed in — run `claude` in a terminal once" }
        : !hasEffortLine
          ? { reason: "Update Claude Code to choose a thinking effort." }
          : {}),
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
  private readonly usage: RequestUsageCollector;
  private usageFinished = false;
  private pendingUsage: AgentRuntimeEvent[] = [];
  /**
   * Per-request usage keyed by message id. One API turn can emit several assistant
   * messages sharing a message id, so per-id replacement — never naive addition —
   * keeps the cumulative turn totals monotonic for the ledger's cumulative counter.
   */
  private readonly requestUsageByMessage = new Map<
    string,
    { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  >();
  /** Last assistant message id, so a later stream delta can update that request. */
  private lastMessageId?: string;
  constructor(private readonly pin: RuntimePin) {
    this.usage = new RequestUsageCollector({
      provider: "anthropic",
      model: pin.modelId!,
      mappingVersion: "claude-result-v1",
      scope: "native-turn",
      inputSemantics: "additive-cache-categories",
      limitations: ["native-request-detail-unavailable"],
    });
  }
  startUsage() {
    return usageEvent(this.usage.start());
  }
  drainUsage() {
    return this.pendingUsage.splice(0);
  }
  finishUsage(outcome: Exclude<UsageOutcome, "started">) {
    if (!this.usageFinished) {
      this.pendingUsage.push(usageEvent(this.usage.finish(outcome)));
      this.usageFinished = true;
    }
    return this.drainUsage();
  }
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
  private recordMessageUsage(
    message: { id?: unknown; usage?: unknown } | undefined,
  ): AgentRuntimeEvent | undefined {
    if (!this.initialized || this.usageFinished || !message || typeof message.id !== "string")
      return undefined;
    const usage = message.usage;
    if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
    const counts = usage as Record<string, unknown>;
    const present = (key: string) =>
      typeof counts[key] === "number" &&
      Number.isFinite(counts[key]) &&
      Number.isInteger(counts[key])
        ? (counts[key] as number)
        : undefined;
    const input = present("input_tokens");
    const output = present("output_tokens");
    // Missing cache fields count as zero once input is present. The additive mapping
    // otherwise drops the input when either cache category is absent.
    const next = {
      input,
      output,
      cacheRead: present("cache_read_input_tokens") ?? (input === undefined ? undefined : 0),
      cacheWrite: present("cache_creation_input_tokens") ?? (input === undefined ? undefined : 0),
    };
    if (Object.values(next).every((value) => value === undefined)) return undefined;
    this.lastMessageId = message.id;
    const prior = this.requestUsageByMessage.get(message.id);
    const maxField = (a?: number, b?: number) =>
      a === undefined ? b : b === undefined ? a : Math.max(a, b);
    this.requestUsageByMessage.set(message.id, {
      input: maxField(prior?.input, next.input),
      output: maxField(prior?.output, next.output),
      cacheRead: maxField(prior?.cacheRead, next.cacheRead),
      cacheWrite: maxField(prior?.cacheWrite, next.cacheWrite),
    });
    const totals: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } = {};
    for (const entry of this.requestUsageByMessage.values())
      for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const)
        if (entry[key] !== undefined) totals[key] = (totals[key] ?? 0) + entry[key];
    return usageEvent(this.usage.snapshot(totals));
  }
  /** True when a final total would move a field below its recorded mid-run spend. */
  private midRunExceeds(totals: Record<string, unknown>): boolean {
    const recorded: Record<string, number | undefined> = {};
    for (const entry of this.requestUsageByMessage.values())
      for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const)
        if (entry[key] !== undefined) recorded[key] = (recorded[key] ?? 0) + entry[key];
    return Object.entries(recorded).some(
      ([key, value]) => typeof totals[key] === "number" && (totals[key] as number) < (value ?? 0),
    );
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
        | {
            type?: string;
            message?: { id?: unknown; model?: string; usage?: unknown };
            delta?: { type?: string; text?: string };
            usage?: unknown;
          }
        | undefined;
      if (event?.type === "message_start") {
        this.model(event.message?.model);
        const midRunUsage = this.recordMessageUsage(event.message);
        if (midRunUsage) return [midRunUsage];
      }
      if (event?.type === "message_delta" && this.lastMessageId) {
        const midRunUsage = this.recordMessageUsage({ id: this.lastMessageId, usage: event.usage });
        if (midRunUsage) return [midRunUsage];
      }
      if (
        event?.type === "content_block_delta" &&
        event.delta?.type === "text_delta" &&
        this.initialized
      )
        return [{ type: "text", text: event.delta.text ?? "" }];
    }
    if (value.type === "assistant") {
      const message = value.message as
        | { id?: unknown; model?: string; usage?: unknown }
        | undefined;
      this.model(message?.model);
      // Assistant messages are Anthropic BetaMessage objects and carry that request's
      // `usage` (input_tokens, output_tokens, cache_*_input_tokens) mid-run. Recording
      // each one lets the delegation gate stop a worker at its reservation instead of
      // only learning the spend from the terminal result event.
      const midRunUsage = this.recordMessageUsage(message);
      if (midRunUsage) return [midRunUsage];
    }
    if (value.type === "result") {
      if (this.usageFinished) return [];
      this.effort(value);
      const usage = value.modelUsage as Record<string, unknown> | undefined;
      if (usage && typeof usage === "object" && this.initialized) {
        for (const model of Object.keys(usage)) this.model(model);
        const tokens = usage[this.pin.modelId!] as Record<string, unknown> | undefined;
        if (tokens && typeof tokens === "object") {
          const totals = {
            input: tokens.inputTokens,
            output: tokens.outputTokens,
            cacheRead: tokens.cacheReadInputTokens,
            cacheWrite: tokens.cacheCreationInputTokens,
          };
          if (this.midRunExceeds(totals)) {
            // A final total below the recorded mid-run spend is a counter discontinuity;
            // keep the mid-run measurements instead of forcing the ledger backwards.
            this.usage.limit("counter-discontinuity");
          } else {
            this.usage.snapshot(totals);
          }
        }
      }
      if (value.is_error || value.subtype !== "success" || !this.initialized) {
        this.pendingUsage.push(...this.finishUsage("failed"));
        // The reason comes from the documented result fields (subtype, then the result or
        // errors text for limit and sign-in signals); the raw vendor text is never echoed.
        const reasonId =
          value.subtype === "error_max_turns"
            ? ("max-turns" as const)
            : (nativeFailureCategory(nativeFailureDetail(value.result, value.errors)) ??
              (value.subtype === "error_max_budget_usd" ? ("usage-limit" as const) : undefined));
        throw new RuntimePinError(
          reasonId
            ? nativeFailureProblem(this.pin, reasonId)
            : runtimePinProblem(
                this.pin,
                "runtime-unavailable",
                "Claude Code could not finish this run — connect it or change the pin.",
              ),
        );
      }
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
      return [...this.finishUsage("success"), { type: "done" }];
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
  constructor(
    private readonly start: NativeSpawn = guardNativeSpawn(spawnNative, guardrailConfigFromEnv()),
  ) {}
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
    if (code !== 0 || !supportedClaudeVersion(version))
      throw new RuntimePinError(
        runtimePinProblem(pin, "runtime-unavailable", "Update Claude Code to use this runtime."),
      );
    const help = await probeCommand(binary, ["--help"], true, this.start).catch(() => ({
      code: -1,
      output: undefined,
    }));
    const model = claudeModels(version, help.output).find((entry) => entry.id === pin.modelId);
    if (!model?.efforts.includes(pin.effort ?? ""))
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
        for (const event of parser.finishUsage("cancelled")) queue.push(event);
        queue.end();
        if (child) terminateNative(child, "SIGTERM");
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
      for (const event of parser.finishUsage(
        context?.signal?.reason?.name === "TimeoutError" ? "timed-out" : "cancelled",
      ))
        queue.push(event);
      queue.end();
      if (child) terminateNative(child, "SIGTERM");
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
      queue.push(parser.startUsage());
      const capturedStderr = captureChildOutput(child, {
        kind: "claude-code",
        runId: request.runId,
        secrets: [...mcpConfigSecrets(mcp.config), ...environmentSecrets(nativeEnvironment())],
        logger: childProcessLogger(),
      });
      const exited = new Promise<number | null>((resolve) => {
        child!.once("close", resolve);
        child!.once("error", () => resolve(-1));
      });
      void exited.then(() => capturedStderr.close());
      child.once("error", () => {
        for (const event of parser.finishUsage("failed")) queue.push(event);
        queue.end(
          new RuntimePinError(
            runtimePinProblem(
              pin,
              "runtime-unavailable",
              "Claude Code could not start — connect it or change the pin.",
            ),
          ),
        );
      });
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
          for (const event of [...parser.drainUsage(), ...parser.finishUsage("failed")])
            queue.push(event);
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
