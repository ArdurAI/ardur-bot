import { createHash } from "node:crypto";
import type { AdapterContext, ComputerRef, SandboxProvider } from "@ardurbot/adapter-kit";
import type { CommandBlock, CommandEventPayload, CommandRefusalId } from "@ardurbot/contracts";
import {
  COMMAND_REFUSALS,
  COMMAND_SUPPRESSED,
  COMMAND_TEXT_LIMIT,
  COMMAND_TRUNCATED,
  CommandEventPayloadSchema,
  CommandRefusalError,
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

/**
 * Conservative text matching, not shell evaluation. Remove quote/escape spelling tricks
 * once so output suppression and known-value refusal share the same view of a command.
 */
export function normalizeShellText(value: string): string {
  return value
    .replace(/\$(['"])/g, "$1")
    .replace(/\\([\s\S])/g, "$1")
    .replace(/['"]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Suppress credential reads, not development commands that merely mention credential names.
 * This is an output safeguard, not a shell authorization grammar; other output is redacted.
 */
export function sensitiveShellCommand(command: string): boolean {
  const wrapperPrefix =
    "(?:(?:[A-Za-z_]\\w*=[^\\s;&|()]+\\s+)|" +
    "(?:[^\\s;&|()]+/)?(?:eval|xargs|sudo|doas|nohup|time|nice|exec|command|builtin)\\s+|" +
    "(?:[^\\s;&|()]+/)?(?:sh|bash|zsh|dash|ksh)\\s+-(?:c|lc|ic)\\s+|" +
    "(?:[^\\s;&|()]+/)?docker\\s+exec\\s+[^\\s;&|()]+\\s+|" +
    "(?:[^\\s;&|()]+/)?kubectl\\s+exec\\s+[^;&|()\\n]*?\\s+--\\s+|" +
    "(?:[^\\s;&|()]+/)?ssh\\s+[^\\s;&|()]+\\s+|" +
    "(?:[^\\s;&|()]+/)?timeout\\s+[^\\s;&|()]+\\s+|" +
    "(?:[^\\s;&|()]+/)?env\\s+)";
  const position = `(?:^|[;&|()\\n])\\s*(?:${wrapperPrefix})*(?:[^\\s;&|()]+/)?`;
  const environmentRead = new RegExp(
    position +
      "(?:printenv\\b|(?:(?:declare|typeset)\\s+-(?:x|p)|set|export(?:\\s+-p)?)\\s*(?=$|[;&|)<>\\n])|" +
      "env(?:\\s+(?:-[0i]+|--null|--ignore-environment|(?:-u|--unset)\\s+\\w+|--unset=\\w+|[A-Za-z_]\\w*=[^\\s;&|()]+))*\\s*(?=$|[;&|)<>\\n]))",
    "i",
  );
  const keychainRead = new RegExp(
    position +
      "(?:security\\s+(?:find-[\\w-]+|dump-keychain|show-keychain-info|list-keychains)\\b|keychain\\b)",
    "i",
  );
  const gitGlobalOption =
    "(?:(?:-C|-c|--git-dir|--work-tree)\\s+[^\\s;&|()]+\\s+|" +
    "(?:--git-dir|--work-tree)=[^\\s;&|()]+\\s+|--no-pager\\s+)";
  const credentialToolRead = new RegExp(
    position +
      "(?:gh\\s+auth\\s+token\\b|" +
      "git\\s+(?:" +
      gitGlobalOption +
      ")*credential(?:-[\\w-]+)?\\b(?![\\w-]|\\s+--help\\s*(?:$|[;&|\\n]))|" +
      "gpg\\s+[^;&|\\n]*--export-secret-(?:sub)?keys\\b|" +
      "security\\s+export\\b|" +
      "aws\\s+(?:configure\\s+export-credentials|sts\\s+(?:get-session-token|assume-role))\\b|" +
      "gcloud\\s+auth\\s+print-(?:access|identity)-token\\b|" +
      "az\\s+account\\s+get-access-token\\b|" +
      "vault\\s+(?:read|kv\\s+get|token)\\b|" +
      "op\\s+(?:read|item\\s+get)\\b|" +
      "kubectl\\s+get\\s+secrets?\\b)",
    "i",
  );
  // Retain the raw view for newlines and native path separators as well.
  const candidates = [command, normalizeShellText(command)];
  return candidates.some(
    (text) =>
      environmentRead.test(text) ||
      keychainRead.test(text) ||
      credentialToolRead.test(text) ||
      /(?<![\w.-])\.env(?:[.,\s/;&|()<>"]|$)/i.test(text) ||
      sensitiveCredentialDirectory(text),
  );
}

/** Snapshot paths are data, not shell commands: credential files never get before/after images. */
export function sensitiveFilePath(value: string): boolean {
  const portable = value.replaceAll("\\", "/");
  return /(?:^|\/)\.env(?:[./]|$)/i.test(portable) || sensitiveCredentialDirectory(portable);
}

function sensitiveCredentialDirectory(value: string): boolean {
  return (
    /(?:\.(?:ssh|aws|kube|gnupg)[/\\]|[/\\]proc[/\\][^\s;|&]+[/\\]environ\b)/i.test(value) ||
    /(?:^|[/\\\s"'<>=])(?:\.(?:git-credentials|netrc|npmrc|pgpass)|\.docker[/\\]config\.json|\.config[/\\]gh[/\\]hosts\.yml|\.terraform\.d[/\\]credentials[\w.-]*)(?=$|[/\\\s"';&|)])/i.test(
      value,
    )
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
    if (name !== "shell") return invokeTool(tool, name, args, executionId);
    const existing = deliveries.get(executionId);
    if (existing) return existing;
    const delivery = record(args, executionId, tool);
    deliveries.set(executionId, delivery);
    return delivery;
  }

  async function invokeTool(
    tool: Tool,
    name: string,
    args: Record<string, unknown>,
    executionId: string,
  ) {
    try {
      return await tool(name, args, executionId);
    } catch (error) {
      if (error instanceof CommandRefusalError)
        return { error: error.message, refusalId: error.refusalId };
      throw error;
    }
  }

  async function record(args: Record<string, unknown>, executionId: string, tool: Tool) {
    const parsed = CommandRequestSchema.safeParse({
      command: args.command ?? args.cmd,
      ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
    });
    const request = parsed.success ? parsed.data : null;
    let resolvedCwd: string | null = null;
    let cwdError = false;
    let cwdRefusal: CommandRefusalId | undefined;
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
    } catch (error) {
      cwdError = true;
      if (error instanceof CommandRefusalError) cwdRefusal = error.refusalId;
    }
    const command = safe(request?.command ?? "[Invalid command]");
    const cwd = resolvedCwd === null ? null : safe(resolvedCwd);
    const unchanged =
      request !== null &&
      command === request.command &&
      cwd === resolvedCwd &&
      (request.cwd === undefined || safe(request.cwd) === request.cwd);
    const containsKnownSecret = [request?.command, request?.cwd, resolvedCwd].some((value) => {
      if (typeof value !== "string") return false;
      const normalized = normalizeShellText(value);
      const compact = normalized.replace(/\s/g, "");
      return input.secrets.some(
        (secret) =>
          secret.length > 0 &&
          (value.includes(secret) || normalized.includes(secret) || compact.includes(secret)),
      );
    });
    const rawCommand = args.command ?? args.cmd;
    const oversized =
      typeof rawCommand === "string" &&
      (rawCommand.length > COMMAND_TEXT_LIMIT ||
        new TextEncoder().encode(rawCommand).byteLength > COMMAND_TEXT_LIMIT);
    const suppress = sensitiveShellCommand(request?.command ?? "");
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
        !request || containsKnownSecret || cwdError
          ? {
              ...(oversized
                ? { refusalId: "command-size" }
                : cwdRefusal
                  ? { refusalId: cwdRefusal }
                  : {}),
              error: oversized
                ? COMMAND_REFUSALS["command-size"]
                : cwdRefusal
                  ? COMMAND_REFUSALS[cwdRefusal]
                  : "This command was not run because its arguments could not be retained safely; use managed credential variables.",
            }
          : await invokeTool(tool, "shell", { ...request }, executionId);
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
        ...(value.error && typeof value.refusalId === "string"
          ? { refusalId: safe(value.refusalId) }
          : {}),
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
