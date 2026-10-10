import type { GroupMember, ThreadSnapshot } from "@ardurbot/contracts";
import { chiefWantsIndividualReplies, parseChiefCorrection } from "./chief-loop-policy.js";
import type { ComposerMention } from "./composer-mentions.js";
import { serializeComposerPrompt } from "./composer-slash.js";
import type { GroupMemberRef } from "./group-mentions.js";
import { hasMentionToken, resolveAddressedBotIds } from "./group-mentions.js";

/** Explicit room recipients, shared by authoritative send and local draft presentation. */
export function groupMentionBotIds(input: {
  text: string;
  members: GroupMemberRef[];
  explicitMentions?: readonly string[];
}): string[] {
  const addressed = resolveAddressedBotIds(input);
  const everyone =
    hasMentionToken(input.text, "everyone") || chiefWantsIndividualReplies(input.text);
  return input.members
    .filter(
      (member) =>
        everyone ||
        input.explicitMentions?.includes(member.id) ||
        hasMentionToken(input.text, member.name) ||
        addressed.includes(member.id),
    )
    .map((member) => member.id);
}

export function groupMessageRecipientIds(input: {
  text: string;
  members: GroupMemberRef[];
  explicitMentions?: readonly string[];
  replyBotId?: string | null;
  coordinatorBotId?: string | null;
  defaultBotId?: string | null;
}): string[] {
  const allowed = (id: string | null | undefined) =>
    input.members.some((member) => member.id === id) ? id : undefined;
  const coordinator = allowed(input.coordinatorBotId);
  if (coordinator && parseChiefCorrection(input)) return [coordinator];
  const explicit = groupMentionBotIds(input);
  if (explicit.length) return explicit;
  const target = allowed(input.replyBotId) ?? allowed(input.defaultBotId);
  return target ? [target] : [];
}

export type GroupRecipientContext = {
  members: readonly Pick<GroupMember, "botId" | "name">[];
  groupRouting?: ThreadSnapshot["groupRouting"];
  activeRuns?: readonly { botId?: string; status: string }[];
};

/** Render known routing state only; this never admits work or sends an unsent draft. */
export function composerGroupRecipientNames(input: {
  group?: GroupRecipientContext;
  draft: string;
  skill?: { name: string } | null;
  mentions?: ComposerMention[];
  replyBotId?: string | null;
}): string[] {
  const { group, mentions = [] } = input;
  if (
    !group?.groupRouting ||
    mentions.some((mention) => mention.kind === "group" || mention.kind === "routine") ||
    (!input.skill && input.draft.trimStart().startsWith("/"))
  )
    return [];
  const ids = groupMessageRecipientIds({
    text: serializeComposerPrompt(input.draft, input.skill ?? null, mentions),
    members: group.members.map((member) => ({ id: member.botId, name: member.name })),
    explicitMentions: mentions
      .filter((mention) => mention.kind === "bot")
      .map((mention) => mention.id),
    replyBotId: input.replyBotId,
    ...group.groupRouting,
  });
  return ids.flatMap((id) => {
    const member = group.members.find((member) => member.botId === id);
    return member ? [member.name] : [];
  });
}

export function queuedGroupRecipientNames(group?: GroupRecipientContext): string[] {
  const ids = new Set(
    group?.activeRuns?.filter((run) => run.status === "queued").map((run) => run.botId),
  );
  return (
    group?.members.filter((member) => ids.has(member.botId)).map((member) => member.name) ?? []
  );
}
