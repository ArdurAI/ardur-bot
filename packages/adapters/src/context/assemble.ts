import type { AgentRunRequest } from "@ardurbot/adapter-kit";
import type { ContextBudgets, ContextSnapshot, RoutingRule } from "@ardurbot/contracts";
import { ContextBudgetsSchema } from "@ardurbot/contracts";
import { escapePromptData } from "@ardurbot/core";

type Message = AgentRunRequest["history"][number];
const RESULT_TRUNCATED_MARKER =
  "[Result truncated to fit the history budget; open the thread for the full report.]";
// Overflowing history starts on a grid of quarter-budget steps: it gives up less than a quarter
// of its budget, and its first kept character moves every few turns instead of every message.
const HISTORY_STEPS = 4;
const TOOL_CALL_ID = /<tool_call\b[^>]*\bid="([^"]+)"/;
const STOP_WORDS = new Set(
  "the a an and or but is are was were be been do does did have has had i we you it this that these those what which who when where how why please about for from with can could would should tell me our your in on of to at as my any".split(
    " ",
  ),
);
function words(text: string) {
  return (text.toLocaleLowerCase("en").match(/[\p{L}\p{N}_-]{3,}/gu) ?? []).filter(
    (word) => !STOP_WORDS.has(word),
  );
}
export function needsRecall(text: string, brief: string): boolean {
  if (
    !/[?？]|\b(remember|recall|earlier|previous|find|lookup|look up|summari[sz]e|status|decision|deadline)\b/i.test(
      text,
    )
  )
    return false;
  const known = new Set(words(brief));
  return words(text).some((word) => !known.has(word));
}
/** A tool call and its result are the call tag and the next result that names the same id. */
function toolPairSpans(messages: Message[]): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let offset = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    const call = TOOL_CALL_ID.exec(message.content);
    const next = messages[index + 1];
    if (call && next?.content.includes(`<tool_result id="${call[1]}">`))
      spans.push({ start: offset, end: offset + message.content.length + next.content.length });
    offset += message.content.length;
  }
  return spans;
}
function sliceFrom(messages: Message[], start: number): Message[] {
  const result: Message[] = [];
  let offset = 0;
  for (const message of messages) {
    const end = offset + message.content.length;
    if (end > start)
      result.push(
        offset >= start ? message : { ...message, content: message.content.slice(start - offset) },
      );
    offset = end;
  }
  return result;
}
function frame(name: string, text: string, budget: number) {
  if (!text.trim()) return "";
  const prefix = `<${name}>\n`;
  const suffix = `\n</${name}>`;
  const escaped = escapePromptData(text);
  return prefix + escaped.slice(0, Math.max(0, budget - prefix.length - suffix.length)) + suffix;
}
/** Keeps whole lines, so a bounded directory never ends partway through a member. */
function frameLines(name: string, text: string, budget: number) {
  if (!text.trim()) return "";
  const prefix = `<${name}>\n`;
  const suffix = `\n</${name}>`;
  let room = budget - prefix.length - suffix.length;
  const kept: string[] = [];
  for (const line of escapePromptData(text).split("\n")) {
    const cost = line.length + (kept.length ? 1 : 0);
    if (cost > room) break;
    kept.push(line);
    room -= cost;
  }
  return kept.length ? prefix + kept.join("\n") + suffix : "";
}

/**
 * Keep the newest messages that fit the budget. The first kept character moves forward in whole
 * steps, not with every new message, so the kept history repeats byte for byte until the next
 * step and provider prompt caches can reuse it. A step of 1 keeps exactly the last `budget`.
 * The cut never moves past the newest message, or past a tool call and its result. If aligning
 * to the grid would drop more than one step of the history the exact cut kept, the exact cut wins.
 */
export function boundMessages(messages: Message[], budget: number, step = 1): Message[] {
  if (budget <= 0) return [];
  const total = messages.reduce((size, message) => size + message.content.length, 0);
  if (total <= budget) return messages;
  const overflow = total - budget;
  const safeStep = Math.max(1, Math.floor(step));
  let start = Math.ceil(overflow / safeStep) * safeStep;
  // A step larger than the room left rounds past the end and drops the newest turn.
  if (start >= total) start = overflow;
  const newestStart = total - (messages.at(-1)?.content.length ?? 0);
  if (start > newestStart && overflow <= newestStart)
    start = newestStart - overflow <= safeStep ? newestStart : overflow;
  for (const span of toolPairSpans(messages)) {
    const enters = start > span.start && start < span.end;
    const passes = start >= span.end && overflow < span.end;
    if (!enters && !passes) continue;
    start = overflow <= span.start && span.start - overflow <= safeStep ? span.start : overflow;
  }
  if (start >= total) start = overflow;
  return sliceFrom(messages, start);
}
/**
 * Provider prompt caches reuse only the leading part of a request that repeats byte for byte,
 * so the layout runs from most to least stable: instructions, the compacted summary, the
 * bounded messages, then data observed fresh for this turn (teammates, brief, required result,
 * recall) and finally the latest turn, which carries the goal state.
 */
export async function assembleTurnContext(run: {
  peerReadOnly?: boolean;
  instructions: string;
  tools?: AgentRunRequest["tools"];
  brief?: string | null;
  summary?: string | null;
  teammates?: string;
  goal?: string;
  history: Message[];
  requiredContext?: Message;
  message: string;
  query?: string;
  sourceMessageId?: string | null;
  budgets?: Partial<ContextBudgets>;
  routingRule?: RoutingRule | null;
  queueWaitMs?: number | null;
  recall?: () => Promise<string>;
}) {
  const budgets = ContextBudgetsSchema.parse(run.budgets ?? {});
  // Discovery has already applied Capabilities' access mode. Count only exposed schemas.
  const toolCharacters =
    Array.isArray(run.tools) && run.tools.length
      ? JSON.stringify(
          run.tools.map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
          })),
        ).length
      : 0;
  const stableCharacters = run.instructions.length + toolCharacters;
  // Instructions and the new request are authority-bearing. Never silently cut either in half.
  // Goal state used to share the instruction budget. It still does, so a message that fit
  // before still fits; the goal is not charged against the message the user can send.
  const goal = run.goal && !run.peerReadOnly ? run.goal : "";
  if (stableCharacters + goal.length > budgets.stable)
    throw new Error(
      "Bot instructions exceed the context budget including exposed tools. Increase the space budget or load tools when needed.",
    );
  if (run.message.length > budgets.message)
    throw new Error("This message exceeds the context budget. Send a shorter message.");
  const prompt = goal ? `${goal}\n\n${run.message}` : run.message;
  const brief = frame("group_brief", run.peerReadOnly ? "" : (run.brief ?? ""), budgets.brief);
  const summary = frame(
    "thread_summary",
    run.peerReadOnly ? "" : (run.summary ?? ""),
    budgets.summary,
  );
  const required = run.requiredContext;
  const requiredAllowance = Math.min(required?.content.length ?? 0, budgets.messages);
  const teammateAllowance = Math.min(
    8_000,
    Math.floor(Math.max(0, budgets.messages - requiredAllowance) / 3),
  );
  const teammates =
    teammateAllowance >= 64
      ? frameLines("teammate_directory", run.teammates ?? "", teammateAllowance)
      : "";
  const requiredMessage = required
    ? {
        ...required,
        content:
          required.content.length > budgets.messages
            ? `${required.content.slice(0, budgets.messages - RESULT_TRUNCATED_MARKER.length - 1)}\n${RESULT_TRUNCATED_MARKER}`
            : required.content,
      }
    : undefined;
  const historyBudget = Math.max(0, budgets.messages - requiredAllowance - teammates.length);
  // A quarter of the room left after the required result and the directory, not of the full
  // message budget. A step taken from the full budget can round the cut past a short thread.
  const historyStep = Math.max(1, Math.floor(historyBudget / HISTORY_STEPS));
  const messages = boundMessages(
    (run.peerReadOnly ? [] : run.history).filter(
      (message) => !run.sourceMessageId || message.id !== run.sourceMessageId,
    ),
    historyBudget,
    historyStep,
  );
  const recallRan = Boolean(
    !run.peerReadOnly && run.recall && needsRecall(run.query ?? run.message, run.brief ?? ""),
  );
  const recall = frame("recalled_memory", recallRan ? await run.recall!() : "", budgets.recall);
  // The summary changes only when compaction also moves the start of the messages it precedes.
  const stable: Message[] = [
    ...(summary ? [{ role: "user" as const, content: summary }] : []),
    ...messages,
  ];
  const history: Message[] = [
    ...stable,
    ...(teammates ? [{ role: "user" as const, content: teammates }] : []),
    ...(brief ? [{ role: "user" as const, content: brief }] : []),
    ...(requiredMessage ? [requiredMessage] : []),
    ...(recall ? [{ role: "user" as const, content: recall }] : []),
  ];
  const snapshot: ContextSnapshot = {
    layers: {
      stable: stableCharacters,
      brief: brief.length,
      summary: summary.length,
      messages:
        teammates.length +
        messages.reduce((size, message) => size + message.content.length, 0) +
        (requiredMessage?.content.length ?? 0),
      recall: recall.length,
      message: prompt.length,
    },
    recallRan,
    recallCalls: Number(recallRan),
    cachedTokens: null,
    inputTokens: null,
    timeToFirstTokenMs: null,
    queueWaitMs: run.queueWaitMs ?? null,
    routingRule: run.routingRule ?? null,
  };
  return {
    instructions: run.instructions,
    stablePrefix: run.instructions,
    history,
    /** Leading history entries expected to repeat unchanged on the next turn. */
    stableHistory: stable.length,
    prompt,
    snapshot,
  };
}
