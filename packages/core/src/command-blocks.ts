import type { CommandBlock, ThreadMessage } from "@ardurbot/contracts";
import {
  COMMAND_NOT_RECORDED,
  COMMAND_OUTPUT_LIMIT,
  COMMAND_TRUNCATED,
  CommandEventPayloadSchema,
} from "@ardurbot/contracts";

export type { CommandBlock } from "@ardurbot/contracts";
export { COMMAND_OUTPUT_LIMIT, COMMAND_TRUNCATED } from "@ardurbot/contracts";

export type CommandProjectionEvent = {
  id: string;
  seq: number;
  type: string;
  runId?: string | null;
  threadId: string;
  botId?: string | null;
  createdAt: Date | string;
  payload: unknown;
};

export function isCommandEvent(type: string): boolean {
  return type === "command.intent" || type === "command.started" || type === "command.finished";
}

export function settleCommandBlock(block: CommandBlock, live = false): CommandBlock {
  if (live || (block.outcome !== "running" && block.outcome !== "waiting")) return block;
  return { ...block, outcome: "unknown" };
}

/** Both history reloads and block links must use the current execution lease. */
export function commandRecordingIsLive(
  block: CommandBlock,
  run:
    | {
        status: string;
        leaseFence: number;
        leaseExpiresAt: Date | null;
        attempts: Array<{ id: string; fence: number }>;
      }
    | undefined,
): boolean {
  if (
    !run?.attempts.some(
      (attempt) => attempt.id === block.attemptId && attempt.fence === run.leaseFence,
    )
  )
    return false;
  return (
    (block.outcome === "waiting" && run.status === "waiting_input") ||
    ((run.status === "running" || run.status === "leased") &&
      run.leaseExpiresAt !== null &&
      run.leaseExpiresAt.getTime() > Date.now())
  );
}

/** Ordered replacement events make redelivery idempotent, including output. */
export function projectCommandBlocks(
  events: readonly CommandProjectionEvent[],
  liveRunIds: ReadonlySet<string> = new Set(),
): CommandBlock[] {
  const blocks = new Map<string, CommandBlock>();
  const legacy = new Map<string, CommandBlock>();
  const finishedRuns = new Set<string>();
  const recordedExecutions = new Set<string>();
  const seen = new Set<string>();
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    if (/^run\.(completed|failed|cancelled)$/.test(event.type) && event.runId) {
      finishedRuns.add(event.runId);
    }
    if (isCommandEvent(event.type)) {
      const parsed = CommandEventPayloadSchema.safeParse(event.payload);
      if (!parsed.success || parsed.data.block.runId !== event.runId) continue;
      const block = parsed.data.block;
      blocks.set(block.commandId, block);
      recordedExecutions.add(`${block.runId}:${block.executionId}`);
      continue;
    }
    const payload = event.payload as Record<string, unknown> | null;
    if (!event.runId || payload?.name !== "shell" || typeof payload.executionId !== "string")
      continue;
    const key = `${event.runId}:${payload.executionId}`;
    if (event.type !== "agent.tool.called" && event.type !== "agent.tool.completed") continue;
    legacy.set(key, {
      commandId: `legacy:${key}`,
      runId: event.runId,
      attemptId: null,
      executionId: payload.executionId,
      command: null,
      cwd: null,
      computerId: null,
      computer: null,
      startedAt: null,
      durationMs: null,
      exitCode: null,
      outcome: "unknown",
      stdout: null,
      stderr: null,
      error: null,
      redacted: false,
      truncated: false,
      replayOf: null,
      rerunDisabledReason: "The original command was not recorded.",
    });
  }
  return [
    ...blocks.values(),
    ...[...legacy].filter(([key]) => !recordedExecutions.has(key)).map(([, block]) => block),
  ].map((block) =>
    settleCommandBlock(block, liveRunIds.has(block.runId) && !finishedRuns.has(block.runId)),
  );
}

/** Shared by the web and native reducers; command rows never become narration. */
export function reduceCommandMessages<
  T extends Pick<ThreadMessage, "id" | "role" | "blocks"> & Partial<ThreadMessage>,
>(messages: T[], event: CommandProjectionEvent): Array<T | ThreadMessage> {
  if (/^run\.(completed|failed|cancelled)$/.test(event.type)) {
    return messages.map((message) =>
      message.runId !== event.runId
        ? message
        : {
            ...message,
            blocks: message.blocks.map((block) =>
              block.kind === "command"
                ? { kind: "command" as const, command: settleCommandBlock(block.command) }
                : block,
            ),
          },
    );
  }
  if (!isCommandEvent(event.type)) return messages;
  const [block] = projectCommandBlocks([event], new Set(event.runId ? [event.runId] : []));
  if (!block) return messages;
  const id = `command:${block.commandId}`;
  const previous = messages.find((message) => message.id === id);
  const next: ThreadMessage = {
    id,
    threadId: event.threadId,
    botId: event.botId ?? undefined,
    seq: previous?.seq ?? event.seq,
    role: "bot",
    runId: block.runId,
    createdAt: previous?.createdAt ?? new Date(event.createdAt).toISOString(),
    blocks: [{ kind: "command", command: block }],
  };
  return previous
    ? messages.map((message) => (message.id === id ? next : message))
    : [...messages, next];
}

export function commandSummary(block: CommandBlock): string {
  const duration =
    block.durationMs === null ? COMMAND_NOT_RECORDED : `${Math.round(block.durationMs / 1000)} s`;
  return `Ran \`${block.command ?? COMMAND_NOT_RECORDED}\` in ${block.cwd ?? COMMAND_NOT_RECORDED} · ${duration} · exit ${block.exitCode ?? COMMAND_NOT_RECORDED}`;
}

export function commandOutput(block: CommandBlock): string {
  return `stdout:\n${block.stdout ?? COMMAND_NOT_RECORDED}\nstderr:\n${block.stderr ?? COMMAND_NOT_RECORDED}${block.error ? `\nerror:\n${block.error}` : ""}`;
}

export function searchCommandBlocks(
  blocks: readonly CommandBlock[],
  query: string,
): CommandBlock[] {
  const needle = query.toLocaleLowerCase();
  return blocks.filter((block) => commandOutput(block).toLocaleLowerCase().includes(needle));
}

export function exportCommandLog(runId: string, blocks: readonly CommandBlock[]): string {
  return [
    `Run: ${runId}`,
    "[Redacted export: known secrets masked; sensitive output suppressed]",
    ...blocks.map((block) =>
      [
        "",
        `[${block.startedAt ?? COMMAND_NOT_RECORDED}] ${commandSummary(block)}`,
        `Command: ${block.commandId} · Attempt: ${block.attemptId ?? COMMAND_NOT_RECORDED} · Execution: ${block.executionId}`,
        `Computer: ${block.computer ?? COMMAND_NOT_RECORDED} (${block.computerId ?? COMMAND_NOT_RECORDED})`,
        `Outcome: ${block.outcome}${block.outcome === "unknown" ? " · Completion not recorded" : ""}`,
        ...(block.replayOf ? [`Rerun of: ${block.replayOf}`] : []),
        ...(block.redacted ? ["[Redacted]"] : []),
        ...(block.truncated ? [COMMAND_TRUNCATED] : []),
        commandOutput(block),
      ].join("\n"),
    ),
    "",
  ].join("\n");
}

/** A byte bound at each collector, with no allocation proportional to a flood chunk. */
export function createBoundedCommandOutput(limit = COMMAND_OUTPUT_LIMIT) {
  let text = "";
  let bytes = 0;
  let truncated = false;
  const encoder = new TextEncoder();
  return {
    push(chunk: string) {
      if (truncated || !chunk) return;
      const remaining = Math.max(0, limit - bytes);
      let part = chunk.slice(0, remaining);
      let encoded = encoder.encode(part);
      if (encoded.length > remaining) {
        // Decode only a complete UTF-8 prefix, dropping the boundary character.
        let end = remaining;
        while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--;
        part = new TextDecoder().decode(encoded.subarray(0, end));
        encoded = encoder.encode(part);
      }
      text += part;
      bytes += encoded.length;
      truncated = part.length < chunk.length;
    },
    value: () => text + (truncated ? `\n${COMMAND_TRUNCATED}` : ""),
    get truncated() {
      return truncated;
    },
  };
}

/** Text only: discard OSC/DCS/CSI, controls, and bidi overrides before storage. */
export function stripCommandControls(text: string): string {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Terminal control characters are deliberately removed.
      .replace(/(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Terminal control characters are deliberately removed.
      .replace(/\u001b[P^_][\s\S]*?(?:\u001b\\|$)/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Terminal control characters are deliberately removed.
      .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Terminal control characters are deliberately removed.
      .replace(/\u001b[ -/]*[@-~]/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Terminal control characters are deliberately removed.
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "")
  );
}
