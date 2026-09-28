import type { Bot, Group, Run } from "@ardurbot/contracts";
import { useLingui } from "@lingui/react/macro";
import { activeMemberRun } from "../../lib/thread-events";
import type { ModelSettings } from "../../lib/use-model-settings";
import { resolveBotModelChip, resolveNextRunDisclosure } from "./bot-model-chip";

/**
 * The group header's member/model line: one line, " · " separators like the bot
 * model chip, truncated with an ellipsis when it does not fit. The full text
 * stays in the DOM for screen readers and is repeated in the hover title. A
 * member whose admitted run still uses an older choice keeps the chip's
 * "Next run" disclosure as inline text: the active model plus what the next
 * run will use, from the same comparison the chip uses.
 */
export function GroupParticipantModels({
  activeGroup,
  bots,
  currentRuns,
  modelSettings,
}: {
  activeGroup: Group;
  bots: readonly Bot[];
  currentRuns: readonly Run[];
  modelSettings: ModelSettings | null;
}) {
  const { t } = useLingui();
  const members = activeGroup.members.flatMap((member) => {
    const participant = bots.find((bot) => bot.id === member.botId);
    if (!participant) return [];
    const run = activeMemberRun(currentRuns, member.botId);
    const chip = resolveBotModelChip(participant, modelSettings, {
      pin: member.effectiveRuntimePin,
      run,
      display: "using",
      requested: t`requested`,
      notAvailable: t` · not available`,
    });
    const next = resolveNextRunDisclosure(participant, modelSettings, {
      display: "using",
      run,
      nextPin: member.effectiveRuntimePin,
    });
    return [{ member, chip, next }];
  });
  const fullText = members
    .map(({ member, chip, next }) =>
      chip
        ? `${member.name} · ${chip.pinUnknown ? `${t`Next run`} · ` : ""}${chip.label}${next.differs ? ` · ${t`Next run`} · ${next.label}` : ""}`
        : member.name,
    )
    .join(" · ");
  return (
    <div
      data-testid="group-participant-models"
      className="app-no-drag min-w-0 truncate text-xs text-muted-foreground"
      title={fullText}
    >
      {members.map(({ member, chip, next }, index) => {
        const currentId = chip?.currentId;
        return (
          <span key={member.botId} data-testid={`group-participant-${member.botId}`}>
            {index > 0 ? " · " : null}
            {member.name}
            {chip ? (
              <>
                {" · "}
                <span
                  role="status"
                  aria-label={chip.pinUnknown ? t`Next run` : t`Using ${currentId}`}
                >
                  {chip.pinUnknown ? <>{t`Next run`} · </> : null}
                  {chip.label}
                </span>
                {next.differs ? (
                  <>
                    {" "}
                    · {t`Next run`} · {next.label}
                  </>
                ) : null}
              </>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}
