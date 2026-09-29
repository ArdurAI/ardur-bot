import { assembleTurnContext } from "./assemble.js";

/**
 * Offline prompt-cache check. Provider prompt caches reuse only the part of a request that
 * repeats the previous request byte for byte, so this assembles consecutive turns and measures
 * that shared prefix. Live cache reads and writes come from provider usage, not from here.
 */
export type PrefixTurn = Parameters<typeof assembleTurnContext>[0];

export interface PrefixReuse {
  turn: number;
  requestChars: number;
  /** Leading characters identical to the previous request; zero for the first turn. */
  sharedChars: number;
  /** Tools, instructions and the history the assembler expects to repeat next turn. */
  stableChars: number;
  /** Conversation characters the model still sees after history bounding. */
  keptHistoryChars: number;
}

/** A rough English-text estimate; provider usage reports the real token counts. */
export function estimatedTokens(characters: number): number {
  return Math.round(characters / 4);
}

export function sharedPrefixLength(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  let index = 0;
  while (index < length && left.charCodeAt(index) === right.charCodeAt(index)) index += 1;
  return index;
}

/** The request in the order providers cache it: tools, system text, then every message. */
function requestParts(
  turn: PrefixTurn,
  context: Awaited<ReturnType<typeof assembleTurnContext>>,
): string[] {
  const tools = Array.isArray(turn.tools) ? turn.tools : [];
  return [
    JSON.stringify(
      tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    ),
    context.instructions,
    ...context.history.map(({ role, content }) => `${role}\n${content}`),
    `user\n${context.prompt}`,
  ];
}

export function providerRequestText(
  turn: PrefixTurn,
  context: Awaited<ReturnType<typeof assembleTurnContext>>,
): string {
  return requestParts(turn, context).join("\n\n");
}

export async function measurePrefixReuse(turns: PrefixTurn[]): Promise<PrefixReuse[]> {
  const rows: PrefixReuse[] = [];
  let previous: string | undefined;
  for (const [index, turn] of turns.entries()) {
    const context = await assembleTurnContext(turn);
    const parts = requestParts(turn, context);
    const request = parts.join("\n\n");
    const threadIds = new Set(turn.history.map((message) => message.id));
    rows.push({
      turn: index + 1,
      requestChars: request.length,
      sharedChars: previous === undefined ? 0 : sharedPrefixLength(previous, request),
      stableChars: parts.slice(0, 2 + context.stableHistory).join("\n\n").length,
      keptHistoryChars: context.history
        .filter((message) => message.id && threadIds.has(message.id))
        .reduce((size, message) => size + message.content.length, 0),
    });
    previous = request;
  }
  return rows;
}
