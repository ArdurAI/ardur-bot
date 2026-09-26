import type { CommandBlock, ThreadMessage, ToolResumedPayload } from "@ardurbot/contracts";
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
function replacesCommandBlock(shown: CommandBlock | undefined, next: CommandBlock) {
  return shown?.commandId !== next.commandId || (next.fence ?? 0) >= (shown.fence ?? 0);
}

/** Row id of the card that the resumed call recording `commandId` continues. */
export function resumedCommandMessageId(commandId: string) {
  return `command:resumed:${commandId}`;
}

/** Where resume links place a command id. */
export type CommandJoins = {
  /** A link handed this command id's card to a later call. */
  resumedAway: boolean;
  /** A link joined this command id to the card of the call it repeats. */
  joined: boolean;
};

/** Where `links`, the resume links recorded so far in the command's run, place `commandId`. */
export function commandJoins(links: Iterable<unknown>, commandId: string): CommandJoins {
  const joins = { resumedAway: false, joined: false };
  for (const payload of links) {
    const link = ToolResumedPayloadSchema.safeParse(payload);
    if (!link.success) continue;
    if (link.data.fromCommandId === commandId) joins.resumedAway = true;
    if (link.data.toCommandId === commandId) joins.joined = true;
  }
  return joins;
}

/**
 * The card a command event belongs to: the one rule that stored rows, the projection and the
 * live reducers share. A command id a link resumed away has no card any more, so its late events
 * stay stored as evidence only. The command id a link joined continues the card of the call it
 * repeats. Every other command id has its own card.
 */
export function commandCardId(commandId: string, joins: CommandJoins): string | null {
  if (joins.resumedAway) return null;
  return joins.joined ? resumedCommandMessageId(commandId) : `command:${commandId}`;
}

/**
 * The card a link hands from the killed call to the resumed call, as row ids: `from` is where the
 * killed call's card is under the links before this one. Undefined when the link joins no cards.
 */
export function resumedCardIds(
  link: ToolResumedPayload,
  joinsBefore: (commandId: string) => CommandJoins,
) {
  const { fromCommandId, toCommandId } = link;
  if (!fromCommandId || !toCommandId) return undefined;
  const from = commandCardId(fromCommandId, joinsBefore(fromCommandId));
  return from ? { from, to: resumedCommandMessageId(toCommandId), fromCommandId } : undefined;
}

/** The killed call's card as the resumed call takes it over, remembering the id it resumed away. */
export function resumeCommandCard(block: CommandBlock, fromCommandId: string): CommandBlock {
  return { ...block, resumedFrom: [...new Set([...(block.resumedFrom ?? []), fromCommandId])] };
}

/**
 * One card for a call that a resumed call repeated: the later card's output and outcome, timed
 * from the earlier card's start, still naming the command ids it continues.
 */
function mergeResumedCommand(earlier: CommandBlock, later: CommandBlock): CommandBlock {
  const joined = earlier.resumedFrom ? { ...later, resumedFrom: earlier.resumedFrom } : later;
  const from = earlier.startedAt ? Date.parse(earlier.startedAt) : Number.NaN;
  const start = later.startedAt ? Date.parse(later.startedAt) : Number.NaN;
  if (!Number.isFinite(from) || (Number.isFinite(start) && start <= from)) return joined;
  return {
    ...joined,
    startedAt: earlier.startedAt,
    durationMs:
      later.durationMs === null || !Number.isFinite(start)
        ? later.durationMs
        : start + later.durationMs - from,
  };
}

/** What card `id`, showing `shown`, shows after `next`; undefined when `next` must not change it. */
export function nextCommandCard(
  id: string,
  shown: CommandBlock | undefined,
  next: CommandBlock,
): CommandBlock | undefined {
  if (!replacesCommandBlock(shown, next)) return undefined;
  return shown && id === resumedCommandMessageId(next.commandId)
    ? mergeResumedCommand(shown, next)
    : next;
}

/** Ordered replacement events make redelivery idempotent, including output. */
export function projectCommandBlocks(
  events: readonly CommandProjectionEvent[],
  liveRunIds: ReadonlySet<string> = new Set(),
): CommandBlock[] {
  /** Cards by row id, in the order their rows were created. */
  let cards = new Map<string, CommandBlock>();
  const legacy = new Map<string, CommandBlock>();
  const finishedRuns = new Set<string>();
  const recordedExecutions = new Set<string>();
  /** Resume links recorded so far, by run. */
  const links = new Map<string, ToolResumedPayload[]>();
  const seen = new Set<string>();
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    if (/^run\.(completed|failed|cancelled)$/.test(event.type) && event.runId) {
      finishedRuns.add(event.runId);
    }
    if (event.type === "agent.tool.resumed") {
      const link = ToolResumedPayloadSchema.safeParse(event.payload);
      if (!link.success || !event.runId) continue;
      const prior = links.get(event.runId) ?? [];
      links.set(event.runId, [...prior, link.data]);
      // The resumed call accounts for the call it repeats, so that call is no gap in the record.
      legacy.delete(`${event.runId}:${link.data.from}`);
      const ids = resumedCardIds(link.data, (commandId) => commandJoins(prior, commandId));
      const card = ids && cards.get(ids.from);
      if (!ids || !card || cards.has(ids.to)) continue;
      cards = new Map(
        [...cards].map(([id, block]) =>
          id === ids.from ? [ids.to, resumeCommandCard(card, ids.fromCommandId)] : [id, block],
        ),
      );
      continue;
    }
    if (isCommandEvent(event.type)) {
      const parsed = CommandEventPayloadSchema.safeParse(event.payload);
      if (!parsed.success || parsed.data.block.runId !== event.runId) continue;
      const block = parsed.data.block;
      recordedExecutions.add(`${block.runId}:${block.executionId}`);
      const id = commandCardId(
        block.commandId,
        commandJoins(links.get(block.runId) ?? [], block.commandId),
      );
      const next = id ? nextCommandCard(id, cards.get(id), block) : undefined;
      if (id && next) cards.set(id, next);
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
    ...cards.values(),
    ...[...legacy].filter(([key]) => !recordedExecutions.has(key)).map(([, block]) => block),
  ].map((block) =>
    settleCommandBlock(block, liveRunIds.has(block.runId) && !finishedRuns.has(block.runId)),
  );
}

/** Where the cards a thread already shows place `commandId`, as the links behind them did. */
function messageJoins(
  messages: readonly Pick<ThreadMessage, "id" | "blocks">[],
  commandId: string,
): CommandJoins {
  return {
    resumedAway: messages.some((message) =>
      message.blocks.some(
        (block) => block.kind === "command" && block.command.resumedFrom?.includes(commandId),
      ),
    ),
    joined: messages.some((message) => message.id === resumedCommandMessageId(commandId)),
  };
}

/**
 * `messages` plus the resume links seen so far, kept separately because a reader with only part
 * of the thread loaded may hold a link whose named card is not among its messages.
 */
export interface CommandMessagesState<T> {
  messages: T[];
  /** Resume links seen so far, in order; a growing record independent of what is loaded. */
  links: readonly ToolResumedPayload[];
}

/** Where `commandId` sits: from either loaded messages or a resume link seen since, whichever knows. */
function readerJoins(
  messages: readonly Pick<ThreadMessage, "id" | "blocks">[],
  links: Iterable<unknown>,
  commandId: string,
): CommandJoins {
  const fromMessages = messageJoins(messages, commandId);
  const fromLinks = commandJoins(links, commandId);
  return {
    resumedAway: fromMessages.resumedAway || fromLinks.resumedAway,
    joined: fromMessages.joined || fromLinks.joined,
  };
}

/** Shared by the web and native reducers; command rows never become narration. */
export function reduceCommandMessages<
  T extends Pick<ThreadMessage, "id" | "role" | "blocks"> & Partial<ThreadMessage>,
>(
  state: CommandMessagesState<T>,
  event: CommandProjectionEvent,
): CommandMessagesState<T | ThreadMessage> {
  const { messages, links } = state;
  if (/^run\.(completed|failed|cancelled)$/.test(event.type)) {
    return {
      links,
      messages: messages.map((message) =>
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
      ),
    };
  }
  if (event.type === "agent.tool.resumed") {
    const link = ToolResumedPayloadSchema.safeParse(event.payload);
    if (!link.success) return state;
    const nextLinks = [...links, link.data];
    const ids = resumedCardIds(link.data, (commandId) => readerJoins(messages, links, commandId));
    if (!ids || messages.some((message) => message.id === ids.to))
      return { messages, links: nextLinks };
    // The card the killed call published becomes the card its resumed call finishes, when that
    // card is loaded; otherwise the link is still remembered for the cards it joins going forward.
    return {
      links: nextLinks,
      messages: messages.map((message) =>
        message.id === ids.from
          ? {
              ...message,
              id: ids.to,
              blocks: message.blocks.map((block) =>
                block.kind === "command"
                  ? {
                      kind: "command" as const,
                      command: resumeCommandCard(block.command, ids.fromCommandId),
                    }
                  : block,
              ),
            }
          : message,
      ),
    };
  }
  if (!isCommandEvent(event.type)) return state;
  const [projected] = projectCommandBlocks([event], new Set(event.runId ? [event.runId] : []));
  if (!projected) return state;
  const id = commandCardId(projected.commandId, readerJoins(messages, links, projected.commandId));
  if (!id) return state;
  const previous = messages.find((message) => message.id === id);
  const shown = previous?.blocks[0]?.kind === "command" ? previous.blocks[0].command : undefined;
  const block = nextCommandCard(id, shown, projected);
  if (!block) return state;
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
  return {
    links,
    messages: previous
      ? messages.map((message) => (message.id === id ? next : message))
      : [...messages, next],
  };
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
