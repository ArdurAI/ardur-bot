import { createHash } from "node:crypto";
import type { AdapterContext, ComputerRef, SandboxProvider } from "@ardurbot/adapter-kit";
import type { CommandBlock, CommandEventPayload } from "@ardurbot/contracts";
import { COMMAND_SUPPRESSED, COMMAND_TRUNCATED, CommandRequestSchema } from "@ardurbot/contracts";
import {
  createBoundedCommandOutput,
  createStreamingRedactor,
  sandboxCommandTimeoutMs,
  stripCommandControls,
} from "@ardurbot/core";
import type { ThreadEvents } from "@ardurbot/db";
import { redactBindings } from "@ardurbot/logging";
import { redactAgentCommandResult } from "./agent-environment.js";
import { isToolPauseResult } from "./approval-effect.js";
import { commandComputerFingerprint } from "./command-replay.js";
import { resolveBotWorkspaceCwd } from "./computer-support.js";

export function redactCommandText(text: string, secrets: string[]): string {
  const masked = redactAgentCommandResult(
    { stdout: stripCommandControls(text), stderr: "", code: 0 },
    secrets,
  ).stdout;
  return stripCommandControls(String(redactBindings({ value: masked }).value));
}

/** Known sensitive operations suppress output, including transformed/unknown credentials. */
export function sensitiveShellCommand(command: string): boolean {
  return /(?:\b(?:printenv|env|set|export|security|keychain|secret|password|passwd|token|credential)\b|\.env\b|\.ssh\/|\.aws\/|\/proc\/.*environ)/i.test(
    command,
  );
}

type Tool = (name: string, args: Record<string, unknown>, executionId: string) => Promise<unknown>;
type StoredComputer = {
  id: string;
  scope: string;
  homeKey: string;
  kind: string;
  providerRef: string | null;
};

export function createCommandRecording(input: {
  events: Pick<ThreadEvents, "append">;
  sandbox: SandboxProvider;
  computer: ComputerRef;
  storedComputer: StoredComputer;
  context: AdapterContext & { runId: string; botId: string };
  threadId: string;
  attemptId: string;
  secrets: string[];
  replayOf?: string | null;
}) {
  const entries = new Map<
    string,
    {
      block: CommandBlock;
      started: number;
      suppress: boolean;
      request: { command: string; cwd?: string } | null;
    }
  >();
  const deliveries = new Map<string, Promise<unknown>>();
  const safe = (text: string) => redactCommandText(text, input.secrets);
  const append = (
    type: "command.intent" | "command.started" | "command.finished",
    payload: CommandEventPayload,
  ) =>
    input.events.append({
      spaceId: input.context.spaceId,
      threadId: input.threadId,
      botId: input.context.botId,
      runId: input.context.runId,
      type,
      payload,
    });

  async function invoke(
    name: string,
    args: Record<string, unknown>,
    executionId: string,
    tool: Tool,
  ) {
    if (name !== "shell") return tool(name, args, executionId);
    const existing = deliveries.get(executionId);
    if (existing) return existing;
    const delivery = record(args, executionId, tool);
    deliveries.set(executionId, delivery);
    return delivery;
  }

  async function record(args: Record<string, unknown>, executionId: string, tool: Tool) {
    const parsed = CommandRequestSchema.safeParse({
      command: args.command ?? args.cmd,
      ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
    });
    const request = parsed.success ? parsed.data : null;
    let resolvedCwd: string | null = null;
    let cwdError = false;
    try {
      if (request) {
        const cwd = resolveBotWorkspaceCwd(
          input.storedComputer.scope === "team" ? "team" : "dedicated",
          input.context.botId,
          request.cwd,
        );
        resolvedCwd =
          (await input.sandbox.resolveCommandCwd?.(input.computer, cwd, input.context)) ?? null;
      }
    } catch {
      cwdError = true;
    }
    const command = safe(request?.command ?? "[Invalid command]");
    const cwd = resolvedCwd === null ? null : safe(resolvedCwd);
    const unchanged =
      request !== null &&
      command === request.command &&
      cwd === resolvedCwd &&
      (request.cwd === undefined || safe(request.cwd) === request.cwd);
    const suppress = sensitiveShellCommand(request?.command ?? "") || !unchanged;
    const commandId = createHash("sha256")
      .update(JSON.stringify([input.context.runId, input.attemptId, executionId]))
      .digest("hex");
    const block: CommandBlock = {
      commandId,
      runId: input.context.runId,
      attemptId: input.attemptId,
      executionId,
      command,
      cwd,
      computerId: input.storedComputer.id,
      computer: safe(`${input.computer.kind}:${input.computer.providerRef ?? input.computer.id}`),
      startedAt: new Date().toISOString(),
      durationMs: null,
      exitCode: null,
      outcome: "waiting",
      stdout: null,
      stderr: null,
      error: null,
      redacted: !unchanged || suppress,
      truncated: false,
      replayOf: input.replayOf ?? null,
      rerunDisabledReason:
        !unchanged || suppress
          ? "This command cannot be retained safely for rerun."
          : resolvedCwd === null
            ? "This computer did not record its working directory."
            : null,
    };
    const entry = { block, started: Date.now(), suppress, request };
    entries.set(executionId, entry);
    // Failing this write prevents even approval-effect persistence or execution.
    await append("command.intent", {
      block,
      replay:
        block.rerunDisabledReason || !request
          ? null
          : {
              request,
              computerFingerprint: commandComputerFingerprint(
                input.storedComputer,
                input.computer.providerRef,
                resolvedCwd!,
              ),
            },
    });
    try {
      const result =
        !request || !unchanged || cwdError
          ? {
              error:
                "This command was not run because its arguments could not be retained safely; use managed credential variables.",
            }
          : await tool("shell", { ...request }, executionId);
      if (isToolPauseResult(result)) return result;
      const value = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
      const executed = entry.block.outcome === "running";
      const code = typeof value.code === "number" ? value.code : null;
      entry.block = {
        ...entry.block,
        outcome: input.context.signal.aborted
          ? "cancelled"
          : code !== null
            ? "completed"
            : executed
              ? "unknown"
              : "cancelled",
        durationMs: executed ? Math.max(0, Date.now() - entry.started) : null,
        exitCode: code,
        stdout: typeof value.stdout === "string" ? safe(value.stdout) : null,
        stderr: typeof value.stderr === "string" ? safe(value.stderr) : null,
        error: value.error
          ? safe(typeof value.error === "string" ? value.error : "The command could not finish.")
          : null,
      };
      const retained = `${entry.block.stdout ?? ""}\n${entry.block.stderr ?? ""}`;
      entry.block.redacted ||= /\[redacted|\[Output redacted/i.test(retained);
      entry.block.truncated = retained.includes(COMMAND_TRUNCATED);
      await append("command.finished", { block: entry.block });
      return result;
    } catch {
      entry.block = {
        ...entry.block,
        outcome: input.context.signal.aborted ? "cancelled" : "unknown",
        error: "The command ended without a complete recording.",
      };
      // Cancellation may already fence history writes. The last intent still projects unknown.
      await append("command.finished", { block: entry.block }).catch(() => undefined);
      throw new Error("The command ended without a complete recording.");
    }
  }

  async function execute(
    executionId: string,
    argv: string[],
    cwd: string | undefined,
    env: Record<string, string>,
  ) {
    const entry = entries.get(executionId);
    if (!entry) throw new Error("Command launch intent is missing.");
    input.context.signal.throwIfAborted();
    entry.started = Date.now();
    entry.block = {
      ...entry.block,
      outcome: "running",
      startedAt: new Date(entry.started).toISOString(),
    };
    await append("command.started", { block: entry.block });
    input.context.signal.throwIfAborted();
    const stdout = createBoundedCommandOutput();
    const stderr = createBoundedCommandOutput();
    const outRedactor = createStreamingRedactor(input.secrets);
    const errRedactor = createStreamingRedactor(input.secrets);
    let code: number | null = null;
    for await (const event of input.sandbox.execute(
      input.computer,
      {
        argv,
        cwd,
        env: Object.keys(env).length ? env : undefined,
        timeoutMs: sandboxCommandTimeoutMs(),
      },
      input.context,
    )) {
      if (event.type === "exit") code = event.code;
      if (entry.suppress) continue;
      // Slice before redactor ingestion so a provider's single flood chunk cannot duplicate it.
      if (event.type === "stdout" || event.type === "stderr") {
        const target = event.type === "stdout" ? stdout : stderr;
        const redactor = event.type === "stdout" ? outRedactor : errRedactor;
        for (let offset = 0; offset < event.data.length && !target.truncated; offset += 4096) {
          target.push(redactor.push(event.data.slice(offset, offset + 4096)));
        }
      }
    }
    stdout.push(outRedactor.finish());
    stderr.push(errRedactor.finish());
    const retained = (value: string) => {
      // A lower-level collector can cut a credential mid-value. Suppress that buffer.
      if (input.secrets.length && value.includes(COMMAND_TRUNCATED))
        return `${COMMAND_SUPPRESSED}\n${COMMAND_TRUNCATED}`;
      return safe(value);
    };
    return {
      stdout: entry.suppress ? COMMAND_SUPPRESSED : retained(stdout.value()),
      stderr: entry.suppress ? COMMAND_SUPPRESSED : retained(stderr.value()),
      code,
    };
  }
  function matchesRequest(executionId: string, args: Record<string, unknown>) {
    const request = entries.get(executionId)?.request;
    const parsed = CommandRequestSchema.safeParse(args);
    return Boolean(
      request &&
        parsed.success &&
        request.command === parsed.data.command &&
        request.cwd === parsed.data.cwd,
    );
  }
  return { invoke, execute, matchesRequest };
}
