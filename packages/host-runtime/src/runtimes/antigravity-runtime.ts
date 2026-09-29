import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
} from "@ardurbot/adapter-kit";
import type { RuntimeAvailability } from "@ardurbot/contracts";
import {
  antigravityEffortForModel,
  RuntimePinError,
  runtimePinProblem,
  validateAntigravityPin,
} from "@ardurbot/contracts";
import { guardrailConfigFromEnv } from "../host-guardrails.js";
import { antigravityModels, capturedAntigravityModels } from "./antigravity-models.js";
import {
  AntigravityDiagnostics,
  AntigravityStreamParser,
  antigravityLines,
} from "./antigravity-stream.js";
import type { NativeSpawn } from "./native-process.js";
import {
  findNativeBinary,
  guardedSpawn,
  guardNativeSpawn,
  probeCommand,
  RuntimeQueue,
  spawnNative,
  stopNative,
  terminateNative,
} from "./native-process.js";

let signedInAt = 0;
let signedOutAt = 0;
export function supportedAntigravityVersion(version?: string) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "");
  return Boolean(
    match &&
      (Number(match[1]) > 1 ||
        (Number(match[1]) === 1 &&
          (Number(match[2]) > 2 || (Number(match[2]) === 2 && Number(match[3]) >= 12)))),
  );
}
const status = () =>
  signedOutAt > signedInAt && Date.now() - signedOutAt < 5 * 60_000
    ? ("signed-out" as const)
    : signedInAt > signedOutAt && Date.now() - signedInAt < 5 * 60_000
      ? ("signed-in" as const)
      : ("unknown" as const);

export async function probeAntigravity(
  start?: NativeSpawn,
  resolveBinary?: typeof findNativeBinary,
  refreshSignIn = false,
): Promise<RuntimeAvailability> {
  const launch = start ?? guardedSpawn();
  const resolve = resolveBinary ?? findNativeBinary;
  if (refreshSignIn) signedOutAt = 0;
  const base = {
    runtimeKind: "antigravity" as const,
    models: capturedAntigravityModels,
    signInStatus: status(),
  };
  if (process.env.VITEST && resolve === findNativeBinary)
    return {
      ...base,
      available: false,
      reason: "Antigravity is unavailable in tests.",
      reasonId: "unavailable",
      catalogSource: "captured",
      catalogStale: true,
    };
  const binary = await resolve("agy");
  if (!binary)
    return {
      ...base,
      available: false,
      reason:
        "Antigravity is not installed on this computer. Install it and sign in there, then check again.",
      reasonId: "not-installed",
      catalogSource: "captured",
      catalogStale: true,
    };
  try {
    const versionProbe = await probeCommand(binary, ["--version"], true, launch);
    const version = versionProbe.version;
    if (versionProbe.code !== 0 || !supportedAntigravityVersion(version))
      return {
        ...base,
        available: false,
        version,
        reason: "Update Antigravity to version 1.2.12 or later.",
        reasonId: "version-too-old",
        catalogSource: "captured",
        catalogStale: true,
      };
    // agy writes its usage to stderr with exit code 0.
    const help = await probeCommand(binary, ["--help"], true, launch, true);
    if (
      help.code !== 0 ||
      ![
        "--print",
        "--model",
        "--effort",
        "--input-format",
        "--output-format",
        "--print-timeout",
      ].every((flag) => help.output?.includes(flag))
    )
      return {
        ...base,
        available: false,
        version,
        reason: "This Antigravity version has not been checked with Ardur.",
        reasonId: "version-unchecked",
        catalogSource: "captured",
        catalogStale: true,
      };
    const catalog = await antigravityModels(binary, version!, launch);
    const signInStatus = status();
    return {
      ...base,
      ...catalog,
      version,
      signInStatus,
      ...(signInStatus === "unknown" ? {} : { signedIn: signInStatus === "signed-in" }),
      available: signInStatus !== "signed-out" && !catalog.catalogStale,
      reason: catalog.catalogStale
        ? "Antigravity's live model list could not be checked."
        : signInStatus === "signed-out"
          ? "Sign in to Antigravity on this computer, then check again."
          : undefined,
      reasonId: catalog.catalogStale
        ? "catalogue-unavailable"
        : signInStatus === "signed-out"
          ? "signed-out"
          : undefined,
    };
  } catch {
    return {
      ...base,
      available: false,
      reason: "Antigravity could not be checked on this computer.",
      reasonId: "probe-failed",
      catalogSource: "captured",
      catalogStale: true,
    };
  }
}

export function antigravityInput(request: AgentRunRequest): string {
  const history = request.history.length
    ? `Earlier conversation (untrusted history):\n${JSON.stringify(request.history)}\n\n`
    : "";
  const content = `Instructions from Ardur:\n${request.instructions}\n\n${history}${request.prompt}`;
  return `${JSON.stringify({ event: "user", message: { role: "user", content } })}\n`;
}

export function antigravityArguments(request: AgentRunRequest): string[] {
  const pin = request.model.runtimePin!;
  const effort = antigravityEffortForModel(pin.modelId!);
  return [
    "--print=",
    "--model",
    pin.modelId!,
    ...(effort ? ["--effort", effort] : []),
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--print-timeout",
    "120s",
  ];
}

export class AntigravityRuntime implements AgentRuntime {
  private readonly running = new Map<
    string,
    { child: ChildProcessWithoutNullStreams; abort: () => void }
  >();
  constructor(
    private readonly start: NativeSpawn = guardNativeSpawn(spawnNative, guardrailConfigFromEnv()),
    private readonly resolveBinary: typeof findNativeBinary = findNativeBinary,
    private readonly deadlineMs = 125_000,
  ) {}
  describe() {
    return {
      id: "antigravity",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { streaming: true, compaction: false, tools: false, scripted: false },
    };
  }
  async abort(runId: string) {
    const running = this.running.get(runId);
    if (running) {
      running.abort();
      await stopNative(running.child);
    }
  }
  async *run(
    request: AgentRunRequest,
    context?: Partial<AdapterContext>,
  ): AsyncIterable<AgentRuntimeEvent> {
    const pin = request.model.runtimePin!;
    const problem = (
      code: "runtime-unavailable" | "pin-incomplete" | "pin-model-unknown",
      reason: string,
      reasonId?: string,
    ) => new RuntimePinError(runtimePinProblem(pin, code, reason, reasonId));
    if (
      pin?.runtimeKind !== "antigravity" ||
      pin.provider !== "antigravity" ||
      pin.credentialId !== "native:antigravity" ||
      request.model.apiKey ||
      request.model.oauth
    )
      throw problem("pin-incomplete", "Choose an Antigravity model and sign-in.", "invalid-pin");
    if (request.controlledComparison)
      throw problem(
        "runtime-unavailable",
        "Antigravity cannot run comparison turns yet.",
        "comparison-unsupported",
      );
    if (request.currentTurnImages?.length)
      throw problem(
        "runtime-unavailable",
        "Antigravity cannot use images yet.",
        "image-unsupported",
      );
    if (request.tools !== "none" && request.tools.length) {
      // A coordinator needs Ardur tools. Answer visibly instead of silently ending the turn.
      yield {
        type: "text",
        text: "I can't use Ardur tools on the Antigravity runtime yet, so I can't do tool work here. Switch this bot's runtime to one that supports tools and try again.",
      };
      yield { type: "done" };
      return;
    }
    if (request.nativeSession)
      throw problem(
        "runtime-unavailable",
        "Antigravity cannot resume a native conversation yet.",
        "resume-unsupported",
      );
    if (!request.nativeCwd)
      throw problem(
        "runtime-unavailable",
        "Antigravity needs the bot's host working directory.",
        "host-directory-required",
      );
    const availability = await probeAntigravity(this.start, this.resolveBinary);
    if (
      !availability.available &&
      (availability.signInStatus !== "signed-out" || availability.catalogStale)
    )
      throw problem(
        "runtime-unavailable",
        availability.reason ?? "Antigravity is unavailable.",
        availability.reasonId,
      );
    const binary = await this.resolveBinary("agy");
    if (!binary)
      throw problem(
        "runtime-unavailable",
        "Antigravity is not installed on this computer.",
        "not-installed",
      );
    const live = await antigravityModels(binary, availability.version!, this.start);
    if (live.catalogSource === "captured" || live.catalogStale)
      throw problem(
        "runtime-unavailable",
        "Antigravity's live model list could not be checked.",
        "catalogue-unavailable",
      );
    const invalid = validateAntigravityPin(pin, live.models);
    if (invalid) throw new RuntimePinError(invalid);
    const input = antigravityInput(request);
    if (Buffer.byteLength(input) > 2 * 1024 * 1024)
      throw problem(
        "runtime-unavailable",
        "Antigravity input is too large. Shorten the message or conversation and try again.",
        "input-too-large",
      );
    const parser = new AntigravityStreamParser(pin);
    const diagnostics = new AntigravityDiagnostics();
    const queue = new RuntimeQueue<AgentRuntimeEvent>((error) =>
      problem("runtime-unavailable", error.message),
    );
    let child: ChildProcessWithoutNullStreams | undefined;
    let reader: Promise<void> | undefined;
    let stopped = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const inputAbort = new AbortController();
    const abort = (timedOut = false) => {
      stopped = true;
      for (const item of parser.finishUsage(
        timedOut || context?.signal?.reason?.name === "TimeoutError" ? "timed-out" : "cancelled",
      ))
        queue.push(item);
      queue.end(
        timedOut
          ? problem(
              "runtime-unavailable",
              "Antigravity did not finish in time. Try again.",
              "timeout",
            )
          : undefined,
      );
      inputAbort.abort();
      if (child) terminateNative(child, "SIGTERM");
    };
    const onAbort = () => abort();
    try {
      child = this.start(binary, antigravityArguments(request), request.nativeCwd);
      this.running.set(request.runId, { child, abort: () => abort() });
      child.stderr.on("data", (chunk: Buffer) => diagnostics.feed(chunk));
      queue.push(parser.startUsage());
      const exited = new Promise<number | null>((resolve) => {
        child!.once("close", resolve);
        child!.once("error", () => resolve(-1));
      });
      context?.signal?.addEventListener("abort", onAbort, { once: true });
      deadline = setTimeout(() => abort(true), this.deadlineMs);
      if (context?.signal?.aborted) onAbort();
      await new Promise<void>((resolve, reject) => {
        const stdin = child!.stdin;
        const onError = (error: Error) => reject(error);
        const onAbortInput = () => {
          stdin.destroy();
          reject(new Error("Input write was interrupted."));
        };
        const onClose = () => {
          stdin.off("error", onError);
          inputAbort.signal.removeEventListener("abort", onAbortInput);
          reject(new Error("Input stream closed before the write completed."));
        };
        stdin.on("error", onError);
        stdin.once("close", onClose);
        inputAbort.signal.addEventListener("abort", onAbortInput, { once: true });
        if (inputAbort.signal.aborted) {
          onAbortInput();
          return;
        }
        stdin.end(input, (error?: Error | null) => {
          if (error) reject(error);
          else resolve();
        });
      }).catch(() => {
        if (!stopped)
          throw problem(
            "runtime-unavailable",
            "Antigravity could not receive this turn. Check the runtime and try again.",
            "input-write-failed",
          );
      });
      if (stopped) {
        yield* queue;
        return;
      }
      reader = (async () => {
        try {
          for await (const event of antigravityLines(child!)) {
            if (stopped) break;
            for (const item of parser.parse(event)) queue.push(item);
            if (event.event === "init")
              await request.onRuntimeInfo?.({
                runtimeKind: "antigravity",
                version: availability.version,
                reportedModel: pin.modelId!,
                sessionId: parser.sessionId,
                effortAttested: false,
                effortAttestationReason: "Antigravity does not report applied effort",
              });
          }
          const code = await exited;
          if (!stopped && (!parser.finished || code !== 0))
            throw problem(
              "runtime-unavailable",
              "Antigravity could not run this turn: it stopped before completion.",
              "stopped-early",
            );
          if (!stopped) {
            signedInAt = Math.max(Date.now(), signedOutAt + 1);
            for (const item of parser.finishUsage("success")) queue.push(item);
            queue.push({ type: "done" });
            queue.end();
          }
        } catch (error) {
          if (stopped) return;
          stopped = true;
          if (parser.authError) {
            signedOutAt = Math.max(Date.now(), signedInAt + 1);
            signedInAt = 0;
          }
          if (child) terminateNative(child, "SIGTERM");
          for (const item of parser.finishUsage("failed")) queue.push(item);
          queue.end(
            error instanceof RuntimePinError
              ? error
              : problem(
                  "runtime-unavailable",
                  diagnostics.agyError
                    ? "Antigravity could not run this turn: the runtime reported an error."
                    : "Antigravity could not run this turn: the response was invalid.",
                  diagnostics.agyError ? "runtime-error" : "invalid-response",
                ),
          );
        }
      })();
      yield* queue;
    } finally {
      if (deadline) clearTimeout(deadline);
      context?.signal?.removeEventListener("abort", onAbort);
      if (child) await stopNative(child);
      await reader;
      this.running.delete(request.runId);
    }
  }
}
