import type { CommandBlock, ThreadMessage } from "@ardurbot/contracts";
import {
  COMMAND_NOT_RECORDED,
  COMMAND_OUTPUT_LIMIT,
  COMMAND_TRUNCATED,
  CommandEventPayloadSchema,
  ToolResumedPayloadSchema,
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

/** Events that change a command card, including a resumed call taking over an earlier card. */
export function isCommandCardEvent(type: string): boolean {
  return isCommandEvent(type) || type === "agent.tool.resumed";
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

/**
 * Whether `next` may replace the block a card shows. One rule for every reader: for a command
 * id the block with the highest attempt fence wins, and among equal fences the later event. A
 * late event from an attempt that lost its lease never replaces the recovering attempt's block.
 * A card showing another command id is a resumed call's card joining `next`.
 */
export function replacesCommandBlock(shown: CommandBlock | undefined, next: CommandBlock) {
  return shown?.commandId !== next.commandId || (next.fence ?? 0) >= (shown.fence ?? 0);
}

/** Row id of a card that a resumed call `executionId` continues. */
export function resumedCommandMessageId(runId: string, executionId: string) {
  return `command:resumed:${runId}:${executionId}`;
}

/**
 * One card for a call that a resumed call repeated: the later card's output and outcome,
 * timed from the earlier card's start.
 */
export function mergeResumedCommand(earlier: CommandBlock, later: CommandBlock): CommandBlock {
  const from = earlier.startedAt ? Date.parse(earlier.startedAt) : Number.NaN;
  const start = later.startedAt ? Date.parse(later.startedAt) : Number.NaN;
  if (!Number.isFinite(from) || (Number.isFinite(start) && start <= from)) return later;
  return {
    ...later,
    startedAt: earlier.startedAt,
    durationMs:
      later.durationMs === null || !Number.isFinite(start)
        ? later.durationMs
        : start + later.durationMs - from,
  };
}

/**
 * Cards joined by `agent.tool.resumed` become the latest recorded card, timed from the first.
 * A call with no link keeps its own card.
 */
function joinResumedCommands(
  cards: readonly CommandBlock[],
  previous: ReadonlyMap<string, string>,
): CommandBlock[] {
  if (!previous.size) return [...cards];
  const linked = new Set([...previous.keys(), ...previous.values()]);
  const trace = (key: string) => {
    const seen = new Set<string>();
    let root = key;
    while (previous.has(root) && !seen.has(root)) {
      seen.add(root);
      root = previous.get(root)!;
    }
    return { root, depth: seen.size };
  };
  const groups = new Map<string, { card: CommandBlock; depth: number }[]>();
  for (const card of cards) {
    const key = `${card.runId}:${card.executionId}`;
    if (!linked.has(key)) continue;
    const { root, depth } = trace(key);
    groups.set(root, [...(groups.get(root) ?? []), { card, depth }]);
  }
  const replaced = new Map<CommandBlock, CommandBlock | null>();
  for (const group of groups.values()) {
    const recorded = group.filter(({ card }) => !card.commandId.startsWith("legacy:"));
    const pool = recorded.length ? recorded : group;
    const target = pool.reduce((latest, item) => (item.depth >= latest.depth ? item : latest));
    let merged = target.card;
    for (const { card } of recorded)
      if (card !== target.card) merged = mergeResumedCommand(card, merged);
    for (const { card } of group) replaced.set(card, card === target.card ? merged : null);
  }
  return cards.flatMap((card) => {
    if (!replaced.has(card)) return [card];
    const next = replaced.get(card);
    return next ? [next] : [];
  });
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
  /** Resumed call to the call it repeats, both as `runId:executionId`. */
  const previous = new Map<string, string>();
  const seen = new Set<string>();
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    if (/^run\.(completed|failed|cancelled)$/.test(event.type) && event.runId) {
      finishedRuns.add(event.runId);
    }
    if (event.type === "agent.tool.resumed") {
      const link = ToolResumedPayloadSchema.safeParse(event.payload);
      if (link.success && event.runId)
        previous.set(`${event.runId}:${link.data.to}`, `${event.runId}:${link.data.from}`);
      continue;
    }
    if (isCommandEvent(event.type)) {
      const parsed = CommandEventPayloadSchema.safeParse(event.payload);
      if (!parsed.success || parsed.data.block.runId !== event.runId) continue;
      const block = parsed.data.block;
      if (replacesCommandBlock(blocks.get(block.commandId), block))
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
  return joinResumedCommands(
    [
      ...blocks.values(),
      ...[...legacy].filter(([key]) => !recordedExecutions.has(key)).map(([, block]) => block),
    ],
    previous,
  ).map((block) =>
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
  if (event.type === "agent.tool.resumed") {
    const link = ToolResumedPayloadSchema.safeParse(event.payload);
    if (!link.success || !event.runId) return messages;
    const from = resumedCommandMessageId(event.runId, link.data.from);
    const id = resumedCommandMessageId(event.runId, link.data.to);
    // The card the killed call published becomes the card its resumed call finishes.
    return messages.map((message) =>
      message.id === from ||
      message.blocks.some(
        (block) =>
          block.kind === "command" &&
          block.command.runId === event.runId &&
          block.command.executionId === link.data.from,
      )
        ? { ...message, id }
        : message,
    );
  }
  if (!isCommandEvent(event.type)) return messages;
  const [projected] = projectCommandBlocks([event], new Set(event.runId ? [event.runId] : []));
  if (!projected) return messages;
  const resumed = resumedCommandMessageId(projected.runId, projected.executionId);
  const previous =
    messages.find((message) => message.id === `command:${projected.commandId}`) ??
    messages.find((message) => message.id === resumed);
  const shown = previous?.blocks[0]?.kind === "command" ? previous.blocks[0].command : undefined;
  if (!replacesCommandBlock(shown, projected)) return messages;
  const block =
    previous?.id === resumed && shown ? mergeResumedCommand(shown, projected) : projected;
  const id = previous?.id ?? `command:${block.commandId}`;
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
