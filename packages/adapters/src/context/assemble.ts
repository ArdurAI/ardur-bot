import type { AgentRunRequest } from "@ardurbot/adapter-kit";
import type { ContextBudgets, ContextSnapshot, RoutingRule } from "@ardurbot/contracts";
import { ContextBudgetsSchema } from "@ardurbot/contracts";

type Message = AgentRunRequest["history"][number];
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
function frame(name: string, text: string, budget: number) {
  if (!text.trim()) return "";
  const prefix = `<${name}>\n`;
  const suffix = `\n</${name}>`;
  const escaped = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return prefix + escaped.slice(0, Math.max(0, budget - prefix.length - suffix.length)) + suffix;
}
export function boundMessages(messages: Message[], budget: number): Message[] {
  const result: Message[] = [];
  let remaining = budget;
  for (const message of [...messages].reverse()) {
    if (remaining <= 0) break;
    const content = message.content.slice(-remaining);
    result.unshift({ ...message, content });
    remaining -= content.length;
  }
  return result;
}
export async function assembleTurnContext(run: {
  instructions: string;
  brief?: string | null;
  summary?: string | null;
  history: Message[];
  message: string;
  query?: string;
  sourceMessageId?: string | null;
  budgets?: Partial<ContextBudgets>;
  routingRule?: RoutingRule | null;
  queueWaitMs?: number | null;
  recall?: () => Promise<string>;
}) {
  const budgets = ContextBudgetsSchema.parse(run.budgets ?? {});
  // Instructions and the new request are authority-bearing. Never silently cut either in half.
  if (run.instructions.length > budgets.stable)
    throw new Error("Bot instructions exceed the context budget. Increase the space budget.");
  if (run.message.length > budgets.message)
    throw new Error("This message exceeds the context budget. Send a shorter message.");
  const brief = frame("group_brief", run.brief ?? "", budgets.brief);
  const summary = frame("thread_summary", run.summary ?? "", budgets.summary);
  const messages = boundMessages(
    run.history.filter((message) => !run.sourceMessageId || message.id !== run.sourceMessageId),
    budgets.messages,
  );
  const recallRan = Boolean(run.recall && needsRecall(run.query ?? run.message, run.brief ?? ""));
  const recall = frame("recalled_memory", recallRan ? await run.recall!() : "", budgets.recall);
  const history: Message[] = [
    ...(brief ? [{ role: "user" as const, content: brief }] : []),
    ...(summary ? [{ role: "user" as const, content: summary }] : []),
    ...messages,
    ...(recall ? [{ role: "user" as const, content: recall }] : []),
  ];
  const snapshot: ContextSnapshot = {
    layers: {
      stable: run.instructions.length,
      brief: brief.length,
      summary: summary.length,
      messages: messages.reduce((size, message) => size + message.content.length, 0),
      recall: recall.length,
      message: run.message.length,
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
    prompt: run.message,
    snapshot,
  };
}
