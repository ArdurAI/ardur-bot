import { ChatMarkdown } from "@ardurbot/chat-ui/web";
import type { MessageBlock } from "@ardurbot/contracts";
import { workRecordEntries, workRecordStatus } from "@ardurbot/core";
import { Trans, useLingui } from "@lingui/react/macro";
import { Check, ChevronDown, ChevronRight, X } from "lucide-react";
import { useMemo, useState } from "react";
import { ThreadCommandBlock } from "../ThreadCommandBlock";

export function CompactWorkRecord({
  blocks,
  live = false,
}: {
  blocks: MessageBlock[];
  /** True for the in-flight turn's streaming message. */
  live?: boolean;
}) {
  const { t } = useLingui();
  const [expanded, setExpanded] = useState(false);

  const entries = useMemo(() => workRecordEntries(blocks, live), [blocks, live]);

  if (entries.length === 0) return null;

  const status = workRecordStatus(entries);
  const active = entries.filter((m) => m.evidence.outcome === "pending");
  const isDone = status !== "working";
  const currentState = active.length > 0 ? active[active.length - 1] : entries[entries.length - 1];
  // A historical shell event may carry no command text; the core leaves its
  // title unset and the record names the row here, in the app's language.
  const currentTitle =
    currentState?.evidence.title ??
    (currentState?.block.kind === "command" ? t`Command` : undefined);
  // Collapsed, the status line previews the current activity. Expanded, it
  // steps back to the generic label so the full row below is the single copy
  // of that text.
  const headerTitle = expanded ? undefined : currentTitle;
  // The status icons are visual only, so the name carries the outcome too.
  const title = currentTitle?.trim() ?? "";
  const accessibleName =
    status === "working"
      ? title
        ? t`Working: ${title}`
        : t`Working`
      : status === "failed"
        ? title
          ? t`Failed: ${title}`
          : t`Failed`
        : status === "interrupted"
          ? title
            ? t`Interrupted: ${title}`
            : t`Interrupted`
          : status === "unknown"
            ? title
              ? t`Unknown: ${title}`
              : t`Unknown`
            : title
              ? t`Done: ${title}`
              : t`Done`;

  return (
    <div className="flex flex-col gap-2 my-2 w-full max-w-full">
      <button
        type="button"
        className="flex items-center gap-3 cursor-pointer select-none font-mono text-[12px] text-muted-foreground w-full text-left"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-label={accessibleName}
      >
        <div className="flex items-center gap-2 flex-grow min-w-0">
          {!isDone && (
            <div className="flex items-center gap-2 max-w-[150px] w-full shrink-0">
              <div className="h-[2px] bg-foreground motion-safe:animate-pulse flex-grow"></div>
              <div className="h-[2px] border-t-2 border-dotted border-border w-[50px]"></div>
            </div>
          )}
          {status === "failed" && <X className="w-3.5 h-3.5 text-destructive shrink-0" />}
          {status === "interrupted" && <X className="w-3.5 h-3.5 text-destructive shrink-0" />}
          {status === "unknown" && <Check className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
          {status === "done" && <Check className="w-3.5 h-3.5 text-success shrink-0" />}
          <div className="truncate">
            {headerTitle ??
              (status === "working" ? (
                <Trans>Working</Trans>
              ) : status === "failed" ? (
                <Trans>Failed</Trans>
              ) : status === "interrupted" ? (
                <Trans>Interrupted</Trans>
              ) : status === "unknown" ? (
                <Trans>Unknown</Trans>
              ) : (
                <Trans>Done</Trans>
              ))}
            {currentState?.evidence.outcome === "pending" && " ..."}
          </div>
        </div>
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 shrink-0" />
        )}
      </button>

      {expanded && (
        <div className="flex flex-col gap-3 pl-4 border-l-2 border-border mt-2">
          {entries.map((m, i) => {
            if (m.block.kind === "command") {
              return <ThreadCommandBlock key={i} block={m.block.command} />;
            }
            if (
              m.block.kind === "text" ||
              (m.block.kind === "progress" && m.block.activity !== true)
            ) {
              // Reasoning summaries and interim notes render in full, as
              // Markdown, and update as the text streams. They never appear
              // in the reply bubble.
              return (
                <div
                  key={i}
                  data-testid="work-record-reasoning"
                  className="text-[13.5px] leading-[1.5] text-muted-foreground"
                  dir="auto"
                >
                  <ChatMarkdown streaming={m.evidence.outcome === "pending"}>
                    {m.block.text}
                  </ChatMarkdown>
                </div>
              );
            }
            return (
              <div
                key={i}
                className="flex items-center justify-between gap-4 font-mono text-[12px] text-muted-foreground"
              >
                <span className="truncate">{m.evidence.title}</span>
                <span className="shrink-0 opacity-70">
                  {m.evidence.outcome === "pending" ? (
                    <Trans>running</Trans>
                  ) : m.evidence.durationMs ? (
                    `${(m.evidence.durationMs / 1000).toFixed(1)}s`
                  ) : (
                    ""
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
