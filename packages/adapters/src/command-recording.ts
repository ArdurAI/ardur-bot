import { createHash } from "node:crypto";
import type { AdapterContext, ComputerRef, SandboxProvider } from "@ardurbot/adapter-kit";
import type { CommandBlock, CommandEventPayload } from "@ardurbot/contracts";
import {
  COMMAND_SUPPRESSED,
  COMMAND_TRUNCATED,
  CommandEventPayloadSchema,
  CommandRequestSchema,
  ToolResumedPayloadSchema,
} from "@ardurbot/contracts";
import {
  commandCardId,
  commandJoins,
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

function commandStopUncertain(error: unknown): error is Error {
  return (
    error instanceof Error &&
    "uncertain" in error &&
    (error as { uncertain?: unknown }).uncertain === true
  );
}
type StoredComputer = {
  id: string;
  scope: string;
  homeKey: string;
  kind: string;
  providerRef: string | null;
};

export type ToolCallIdentity = { name: string; argumentDigest: string | null };

/**
 * A repeated id is the same call only when its name and argument digest match. A missing digest
 * never matches, even another missing one: two calls recorded without a digest may still differ.
 */
export function sameToolCall(
  recorded: ToolCallIdentity | undefined,
  call: ToolCallIdentity,
): boolean {
  return (
    recorded !== undefined &&
    recorded.argumentDigest !== null &&
    recorded.name === call.name &&
    recorded.argumentDigest === call.argumentDigest
  );
}

/**
 * Cards an earlier attempt left waiting or running, by execution id, so a call that resumes
 * on the same id finishes its own card. A card belongs to the latest call recorded on its id:
 * an `agent.tool.called` with a different name or argument digest on that id drops it. A card a
 * resumed call took over by `agent.tool.resumed` is filed under the resumed call's execution id
 * with the card id the link names, so a later link can hand it on again even when the resumed
 * call is itself killed before it publishes a card of its own.
 * `finished` names calls that already completed by `agent.tool.completed`.
 * `finishedCommandIds` names a card whose commandId already has a `command.finished`, even when
 * that completion never reached `agent.tool.completed`: a rerun on that id gets its own card and
 * its own result instead of reopening a card already settled. The caller loads
 * `finishedCommandIds` without any finished command's stdout/stderr payload.
 */
export function adoptOpenCommands(
  target: Map<string, CommandBlock>,
  events: readonly { type: string; payload: unknown }[],
  finished: ReadonlySet<string>,
  finishedCommandIds: ReadonlySet<string> = new Set(),
) {
  const calls = new Map<string, ToolCallIdentity>();
  const links: unknown[] = [];
  for (const event of events) {
    if (event.type === "agent.tool.resumed") {
      const link = ToolResumedPayloadSchema.safeParse(event.payload);
      links.push(event.payload);
      for (const [executionId, block] of target) {
        if (commandCardId(block.commandId, commandJoins(links, block.commandId))) continue;
        target.delete(executionId);
        // The link names the card it hands off: file it under the resumed call's execution id,
        // under the card id the link names, so a later link can find and hand it on again.
        if (link.success && link.data.toCommandId && link.data.fromCommandId === block.commandId)
          target.set(link.data.to, { ...block, commandId: link.data.toCommandId });
      }
      continue;
    }
    if (event.type === "agent.tool.called") {
      const call = (event.payload ?? {}) as Record<string, unknown>;
      if (typeof call.executionId !== "string") continue;
      const identity: ToolCallIdentity = {
        name: typeof call.name === "string" ? call.name : "",
        argumentDigest: typeof call.argumentDigest === "string" ? call.argumentDigest : null,
      };
      const recorded = calls.get(call.executionId);
      if (recorded !== undefined && !sameToolCall(recorded, identity))
        target.delete(call.executionId);
      calls.set(call.executionId, identity);
      continue;
    }
    if (event.type !== "command.intent" && event.type !== "command.started") continue;
    const parsed = CommandEventPayloadSchema.safeParse(event.payload);
    if (!parsed.success) continue;
    const block = parsed.data.block;
    if (finished.has(block.executionId)) continue;
    if (finishedCommandIds.has(block.commandId)) continue;
    if (!commandCardId(block.commandId, commandJoins(links, block.commandId))) continue;
    if (block.outcome === "waiting" || block.outcome === "running")
      target.set(block.executionId, block);
  }
}

export function createCommandRecording(input: {
  events: Pick<ThreadEvents, "append">;
  sandbox: SandboxProvider;
  computer: ComputerRef;
  storedComputer: StoredComputer;
  context: AdapterContext & { runId: string; botId: string };
  threadId: string;
  attemptId: string;
  /** Lease fence of this attempt; readers keep the block with the highest fence per command. */
  fence: number;
  secrets: string[];
  replayOf?: string | null;
  resolveCwd?: (requested: string | undefined, executionId: string) => string | undefined;
  /** Waiting or running cards from the killed attempt, keyed by execution id. */
  openCommands?: ReadonlyMap<string, CommandBlock>;
  /** Calls an earlier attempt completed. Their recorded result returns without a second card. */
  finishedCommands?: ReadonlySet<string>;
}) {
  const entries = new Map<
    string,
    {
      block: CommandBlock;
      started: number;
      keepStart: boolean;
      suppress: boolean;
      request: { command: string; cwd?: string } | null;
      /** Finished in an earlier attempt: its recorded result returns and nothing runs. */
      finished: boolean;
    }
  >();
  const deliveries = new Map<string, Promise<unknown>>();
  const safe = (text: string) => redactCommandText(text, input.secrets);
  /** The card a call on `executionId` records: the open card it resumes on that id, or its own. */
  const commandIdFor = (executionId: string) =>
    input.openCommands?.get(executionId)?.commandId ??
    createHash("sha256")
      .update(JSON.stringify([input.context.runId, input.attemptId, executionId]))
      .digest("hex");
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
        const cwd = input.resolveCwd
          ? input.resolveCwd(request.cwd, executionId)
          : resolveBotWorkspaceCwd(
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
    // The same call resuming on its own id finishes the card the killed attempt published.
    const resumeCard = input.openCommands?.get(executionId);
    const commandId = commandIdFor(executionId);
    const preservedStartMs =
      resumeCard?.outcome === "running" && resumeCard.startedAt
        ? Date.parse(resumeCard.startedAt)
        : Number.NaN;
    const keepStart = Number.isFinite(preservedStartMs);
    const block: CommandBlock = {
      commandId,
      runId: input.context.runId,
      // The recovering attempt is the one whose fence matches the live lease.
      attemptId: input.attemptId,
      fence: input.fence,
      executionId,
      command,
      cwd,
      computerId: input.storedComputer.id,
      computer: safe(`${input.computer.kind}:${input.computer.providerRef ?? input.computer.id}`),
      startedAt: keepStart ? resumeCard!.startedAt! : new Date().toISOString(),
      durationMs: null,
      exitCode: null,
      outcome: "waiting",
      stdout: null,
      stderr: null,
      error: null,
      redacted: !unchanged || suppress,
      truncated: false,
      replayOf: resumeCard ? resumeCard.replayOf : (input.replayOf ?? null),
      rerunDisabledReason:
        !unchanged || suppress
          ? "This command cannot be retained safely for rerun."
          : resolvedCwd === null
            ? "This computer did not record its working directory."
            : null,
    };
    const finished = input.finishedCommands?.has(executionId) === true;
    const entry = {
      block,
      started: keepStart ? preservedStartMs : Date.now(),
      keepStart,
      suppress,
      request,
      finished,
    };
    entries.set(executionId, entry);
    // A second intent for a card the killed attempt already published would open another row.
    if (!resumeCard && !finished) {
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
    }
    try {
      const result =
        !request || !unchanged || cwdError
          ? {
              error:
                "This command was not run because its arguments could not be retained safely; use managed credential variables.",
            }
          : await tool("shell", { ...request }, executionId);
      // The earlier attempt's card already shows a finished call.
      if (isToolPauseResult(result) || finished) return result;
      const value = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
      const executed = entry.block.outcome === "running";
      const code = typeof value.code === "number" ? value.code : null;
      // The effect survived the kill as executing or intended: this attempt never started the
      // command itself, and the earlier attempt's outcome is unknown, not this attempt's to cancel.
      const uncertain = value.uncertain === true;
      entry.block = {
        ...entry.block,
        outcome: input.context.signal.aborted
          ? "cancelled"
          : code !== null
            ? "completed"
            : executed || uncertain
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
    } catch (error) {
      if (finished) throw error;
      const uncertain = commandStopUncertain(error);
      entry.block = {
        ...entry.block,
        outcome: uncertain ? "unknown" : input.context.signal.aborted ? "cancelled" : "unknown",
        error: uncertain ? error.message : "The command ended without a complete recording.",
      };
      // Cancellation may already fence history writes. The last intent still projects unknown.
      await append("command.finished", { block: entry.block }).catch(() => undefined);
      if (uncertain) throw error;
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
    // A finished call runs again only if its recorded result is gone; that is refused.
    if (entry.finished) throw new Error("This command already finished in an earlier attempt.");
    input.context.signal.throwIfAborted();
    if (!entry.keepStart) entry.started = Date.now();
    entry.block = {
      ...entry.block,
      outcome: "running",
      ...(entry.keepStart ? {} : { startedAt: new Date(entry.started).toISOString() }),
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
  return { invoke, execute, matchesRequest, commandIdFor };
}
