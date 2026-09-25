import type { RoutingRule } from "@ardurbot/contracts";

export type RouteTarget = { botId: string; threadId: string };
export function routeIncoming(message: {
  text: string;
  bots: Array<RouteTarget & { name: string }>;
  mentionBotIds?: readonly string[];
  replyTo?: RouteTarget | null;
  groupCoordinatorId?: string | null;
  lastActiveThread?: RouteTarget | null;
  spaceCoordinatorId?: string | null;
  defaultBotId?: string | null;
}): (RouteTarget & { rule: RoutingRule; routedByDefault: boolean }) | null {
  const allowed = (target?: RouteTarget | null) =>
    target &&
    message.bots.some((bot) => bot.botId === target.botId && bot.threadId === target.threadId)
      ? target
      : null;
  const byId = (id?: string | null) => message.bots.find((bot) => bot.botId === id);
  const explicit =
    message.mentionBotIds?.map(byId).find(Boolean) ??
    message.bots.find((bot) => {
      const escaped = bot.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(?:^|\\s)@${escaped}(?=$|[\\s,.:!?])`, "iu").test(message.text);
    });
  const candidates: Array<[RoutingRule, RouteTarget | null | undefined]> = [
    ["mention", explicit],
    ["reply", allowed(message.replyTo)],
    ["group-coordinator", byId(message.groupCoordinatorId)],
    ["last-active-thread", allowed(message.lastActiveThread)],
    ["space-coordinator", byId(message.spaceCoordinatorId)],
    ["default", byId(message.defaultBotId) ?? message.bots[0]],
  ];
  for (const [rule, target] of candidates)
    if (target)
      return {
        botId: target.botId,
        threadId: target.threadId,
        rule,
        routedByDefault: rule === "default",
      };
  return null;
}
