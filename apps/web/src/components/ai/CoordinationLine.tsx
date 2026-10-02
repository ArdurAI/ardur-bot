import type { ChiefActivityKey, ChiefDispatch, ChiefReceiptKey } from "@ardurbot/contracts";
import type { CoordinationBlock, CoordinationMember } from "@ardurbot/core";
import { chiefActivityKey, coordinationMemberFailureCode, fixableFailure } from "@ardurbot/core";
import { Button } from "@ardurbot/ui-web";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";

function useTranslatedChiefActivity(key: ChiefActivityKey | undefined) {
  const { t } = useLingui();
  if (!key) return undefined;
  switch (key) {
    case "read-input":
      return t`Reading the document`;
    case "connect-notion":
      return t`Connecting to Notion`;
    case "write-notion":
      return t`Creating the Notion page`;
    case "verify-notion":
      return t`Checking the Notion page`;
    case "check-tool":
      return t`Checking the missing tool`;
    case "waiting-tool":
      return t`Waiting for the tool`;
    default:
      return t`Working on the task`;
  }
}

export function ChiefReceiptText({
  receiptKey,
  memberName,
}: {
  receiptKey: ChiefReceiptKey;
  memberName?: string;
}) {
  const { t } = useLingui();
  const name = memberName;
  const text =
    receiptKey === "exclude-member" && name
      ? t`Got it — I’ll keep ${name} off this task.`
      : receiptKey === "change-task"
        ? t`Got it — I’ll check this change before the next action.`
        : receiptKey === "document-to-service"
          ? t`Got it — I’ll choose a team member to put this in Notion.`
          : receiptKey === "install-tool"
            ? t`Got it — I’ll check what’s missing and ask before installing it.`
            : receiptKey === "greeting"
              ? t`Hi everyone.`
              : t`Got it — I’ll check the request and choose the next step.`;
  return (
    <span data-testid="chief-receipt" aria-live="polite">
      {text}
    </span>
  );
}

/** Only committed dispatch metadata may produce the compact headline. */
export function ChiefDispatchLine({
  dispatch,
  detail,
}: {
  dispatch: ChiefDispatch;
  detail: string;
}) {
  const { t } = useLingui();
  const [expanded, setExpanded] = useState(false);
  const name = dispatch.stop?.memberName ?? dispatch.memberName;
  const label =
    dispatch.stop?.state === "requested"
      ? t`Told ${name} to stand down`
      : dispatch.stop?.state === "confirmed"
        ? t`${name} stood down`
        : dispatch.stop?.state === "uncertain"
          ? t`The previous action may have finished. I’ll check before retrying.`
          : dispatch.stop?.state === "checking"
            ? t`Checking the earlier action`
            : dispatch.state === "approval-held"
              ? t`Waiting for approval`
              : dispatch.state === "queued"
                ? t`Queued for ${name}`
                : t`Messaged ${name}`;
  const activityKey = chiefActivityKey(dispatch);
  const translatedActivity = useTranslatedChiefActivity(activityKey);
  const activity = dispatch.stop
    ? dispatch.stop.state === "requested"
      ? t`Stopping ${name}`
      : undefined
    : translatedActivity;
  return (
    <div className="my-1 text-[13px] text-muted-foreground" data-testid="chief-dispatch">
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left"
        aria-label={[label, activity].filter(Boolean).join(" · ")}
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <span
          className={dispatch.stop?.state === "uncertain" ? "min-w-0" : "truncate"}
          aria-live="polite"
        >
          {label}
        </span>
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
      </button>
      {activity ? (
        <div className="truncate" data-testid="chief-activity" aria-live="polite">
          {activity}
        </div>
      ) : null}
      {expanded ? (
        <div className="mt-2 border-l-2 border-border pl-4" dir="auto">
          {detail}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One coordination round, collapsed to a single line. The request, progress
 * notes and per-member outcomes appear only when the reader expands it, so
 * repeated rounds never lengthen the chat. A member that could not answer for
 * a fixable reason gets one plain sentence with a fix link.
 */
export function CoordinationLine({
  block,
  onOpenMemberSettings,
}: {
  block: CoordinationBlock;
  onOpenMemberSettings?: (botId: string) => void;
}) {
  const { t } = useLingui();
  const [expanded, setExpanded] = useState(false);

  const asked = block.members.length;
  const answered = block.members.filter((member) => member.outcome === "answered").length;
  const anyPending = block.members.some((member) => member.outcome === "pending");
  const accessibleName = t`Coordination round: ${asked} asked, ${answered} answered`;

  return (
    <div className="my-1 w-full max-w-full" data-testid="coordination-line">
      <button
        type="button"
        className="flex w-full cursor-pointer select-none items-center gap-3 text-left font-mono text-[12px] text-muted-foreground"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-label={accessibleName}
        data-testid="coordination-line-toggle"
      >
        <div className="flex min-w-0 flex-grow items-center gap-2">
          {anyPending ? (
            <div className="flex w-full max-w-[150px] shrink-0 items-center gap-2">
              <div className="h-[2px] flex-grow bg-foreground motion-safe:animate-pulse" />
              <div className="h-[2px] w-[50px] border-t-2 border-dotted border-border" />
            </div>
          ) : (
            <Check className="h-3.5 w-3.5 shrink-0 text-success" />
          )}
          <div className="truncate" data-testid="coordination-line-summary">
            <Trans>
              Asked <Plural value={asked} one="# bot" other="# bots" /> ·{" "}
              <Plural value={answered} one="# answered" other="# answered" />
            </Trans>
          </div>
        </div>
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" />
        )}
      </button>

      {!expanded &&
        block.members
          .filter((member) => member.outcome === "failed")
          .slice(0, 1)
          .map((member) => (
            <CoordinationFailureRow
              key={member.botId}
              member={member}
              onOpenMemberSettings={onOpenMemberSettings}
            />
          ))}

      {expanded && (
        <div className="mt-2 flex flex-col gap-3 border-l-2 border-border pl-4">
          <div
            className="text-[13.5px] leading-[1.5] text-muted-foreground"
            dir="auto"
            data-testid="coordination-request"
          >
            {block.text}
          </div>
          {block.updates.map((update, index) => (
            <div
              key={index}
              className="text-[13px] leading-[1.5] text-muted-foreground/80"
              dir="auto"
              data-testid="coordination-update"
            >
              {update}
            </div>
          ))}
          {block.members.map((member) => (
            <CoordinationMemberRow
              key={member.botId}
              member={member}
              onOpenMemberSettings={onOpenMemberSettings}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function MemberOutcome({ member }: { member: CoordinationMember }) {
  switch (member.outcome) {
    case "answered":
      return <Trans>answered</Trans>;
    case "failed":
      return <Trans>couldn't answer</Trans>;
    case "stopped":
      return <Trans>stopped before answering</Trans>;
    case "waiting":
      return <Trans>is waiting for you</Trans>;
    default:
      return <Trans>has not answered yet</Trans>;
  }
}

function CoordinationMemberRow({
  member,
  onOpenMemberSettings,
}: {
  member: CoordinationMember;
  onOpenMemberSettings?: (botId: string) => void;
}) {
  return (
    <div
      className="flex items-center justify-between gap-4 font-mono text-[12px] text-muted-foreground"
      data-testid="coordination-member"
    >
      <span className="truncate">
        {member.name} · <MemberOutcome member={member} />
      </span>
      {member.outcome === "failed" && fixableFailure(member) ? (
        <FixLink botId={member.botId} onOpenMemberSettings={onOpenMemberSettings} />
      ) : null}
    </div>
  );
}

function CoordinationFailureRow({
  member,
  onOpenMemberSettings,
}: {
  member: CoordinationMember;
  onOpenMemberSettings?: (botId: string) => void;
}) {
  const { t } = useLingui();
  const name = member.name;
  // The round stores a reason code; each screen translates it, and rounds
  // stored with an old English reason read through their mapped code.
  const line = (() => {
    switch (coordinationMemberFailureCode(member)) {
      case "auth":
        return t`${name} couldn't answer: its model account needs attention`;
      case "rate-limit":
        return t`${name} couldn't answer: its model account hit a rate limit`;
      case "model-unavailable":
        return t`${name} couldn't answer: its model is unavailable`;
      case "stopped":
        return t`${name} stopped before answering`;
      default:
        return t`${name} couldn't answer`;
    }
  })();
  return (
    <div
      className="flex items-center gap-2 py-0.5 text-[12.5px] text-muted-foreground"
      data-testid="coordination-failure"
    >
      <span className="min-w-0 flex-1 truncate" dir="auto">
        {line}
      </span>
      {fixableFailure(member) ? (
        <FixLink botId={member.botId} onOpenMemberSettings={onOpenMemberSettings} />
      ) : null}
    </div>
  );
}

function FixLink({
  botId,
  onOpenMemberSettings,
}: {
  botId: string;
  onOpenMemberSettings?: (botId: string) => void;
}) {
  return (
    <Button
      variant="link"
      size="xs"
      className="shrink-0"
      onClick={() => onOpenMemberSettings?.(botId)}
    >
      <Trans>Fix</Trans>
    </Button>
  );
}
