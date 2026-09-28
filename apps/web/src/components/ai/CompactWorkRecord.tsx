import { ChatMarkdown } from "@ardurbot/chat-ui/web";
import type { MessageBlock } from "@ardurbot/contracts";
import { workRecordEntries } from "@ardurbot/core";
import { Trans } from "@lingui/react/macro";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { ThreadCommandBlock } from "../ThreadCommandBlock";

export function CompactWorkRecord({
  blocks,
  renderBlock,
}: {
  blocks: MessageBlock[];
  renderBlock?: (block: MessageBlock, i: number) => React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);

  const entries = useMemo(() => workRecordEntries(blocks), [blocks]);

  if (entries.length === 0) return null;

  const active = entries.filter((m) => m.evidence.outcome === "pending");
  const isDone = active.length === 0;
  const currentState = active.length > 0 ? active[active.length - 1] : entries[entries.length - 1];
  // Reasoning summaries render only as full expanded rows; the collapsed
  // status line falls back to the generic label rather than a clipped copy.
  const headerTitle =
    currentState && currentState.evidence.label !== "reasoning"
      ? currentState.evidence.title
      : undefined;

  return (
    <div className="flex flex-col gap-2 my-2 w-full max-w-full">
      <button
        type="button"
        className="flex items-center gap-3 cursor-pointer select-none font-mono text-[12px] text-muted-foreground w-full text-left"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-2 flex-grow min-w-0">
          {!isDone && (
            <div className="flex items-center gap-2 max-w-[150px] w-full shrink-0">
              <div className="h-[2px] bg-foreground motion-safe:animate-pulse flex-grow"></div>
              <div className="h-[2px] border-t-2 border-dotted border-border w-[50px]"></div>
            </div>
          )}
          {isDone && <Check className="w-3.5 h-3.5 text-success shrink-0" />}
          <div className="truncate">
            {headerTitle ?? (isDone ? <Trans>Done</Trans> : <Trans>Working</Trans>)}
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
            const customRender = renderBlock?.(m.block, i);
            if (customRender) {
              return <div key={i}>{customRender}</div>;
            }
            if (m.block.kind === "command") {
              return <ThreadCommandBlock key={i} block={m.block.command} />;
            }
            if (m.evidence.label === "reasoning" && m.block.kind === "progress") {
              // Reasoning summaries render in full, as Markdown, and update as
              // the text streams. They never appear in the reply bubble.
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
