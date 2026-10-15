import type { ComposerMention, ComposerSkill } from "@ardurbot/core";
import type { GroupRecipientContext } from "@ardurbot/core/group-message-recipients";
import {
  composerGroupRecipientNames,
  queuedGroupRecipientNames,
} from "@ardurbot/core/group-message-recipients";
import { useLingui } from "@lingui/react/macro";

export default function GroupRecipients({
  group,
  canSend,
  draft,
  skill,
  mentions,
  replyBotId,
}: {
  group: GroupRecipientContext;
  canSend: boolean;
  draft: string;
  skill: ComposerSkill | null;
  mentions: ComposerMention[];
  replyBotId?: string | null;
}) {
  const { t } = useLingui();
  const names = canSend
    ? composerGroupRecipientNames({ group, draft, skill, mentions, replyBotId }).join(", ")
    : "";
  const queued = queuedGroupRecipientNames(group).join(", ");
  return (
    <>
      {names ? (
        <p
          data-testid="composer-recipients"
          role="status"
          title={t`To ${names}`}
          className="truncate pb-1 ps-12 text-xs text-muted-foreground"
        >
          {t`To ${names}`}
        </p>
      ) : null}
      {queued ? (
        <p
          data-testid="composer-queued"
          role="status"
          title={t`Queued: ${queued}`}
          className="truncate pb-1 ps-12 text-xs text-muted-foreground"
        >
          {t`Queued: ${queued}`}
        </p>
      ) : null}
    </>
  );
}
