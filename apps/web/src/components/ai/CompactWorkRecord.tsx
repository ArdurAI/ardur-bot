import type { MessageBlock } from "@ardurbot/contracts";
import { mapMessageBlockToActivity } from "@ardurbot/core";
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

  const mapped = useMemo(
    () => blocks.map((b) => ({ block: b, evidence: mapMessageBlockToActivity(b) })),
    [blocks],
  );
  const nonNarration = mapped.filter(
    (m) => m.evidence.label !== "narration" && m.evidence.label !== "unavailable",
  );

  if (nonNarration.length === 0) return null;

  const active = nonNarration.filter((m) => m.evidence.outcome === "pending");
  const isDone = active.length === 0;
  const currentState =
    active.length > 0 ? active[active.length - 1] : nonNarration[nonNarration.length - 1];

  return (
    <div className="flex flex-col gap-2 my-2 w-full max-w-full">
      <button
        type="button"
        className="flex items-center gap-3 cursor-pointer select-none font-mono text-[12px] text-muted-foreground w-full text-left"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-2 flex-grow">
          {!isDone && (
            <div className="flex items-center gap-2 max-w-[150px] w-full">
              <div className="h-[2px] bg-foreground motion-safe:animate-pulse flex-grow"></div>
              <div className="h-[2px] border-t-2 border-dotted border-border w-[50px]"></div>
            </div>
          )}
          {isDone && <Check className="w-3.5 h-3.5 text-success" />}
          <div className="whitespace-nowrap">
            {currentState?.evidence.title ??
              (isDone ? <Trans>Done</Trans> : <Trans>Working</Trans>)}
            {currentState?.evidence.outcome === "pending" && " ..."}
          </div>
        </div>
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5" />
        )}
      </button>

      {expanded && (
        <div className="flex flex-col gap-3 pl-4 border-l-2 border-border mt-2">
          {nonNarration.map((m, i) => {
            const customRender = renderBlock?.(m.block, i);
            if (customRender) {
              return <div key={i}>{customRender}</div>;
            }
            if (m.block.kind === "command") {
              return <ThreadCommandBlock key={i} block={m.block.command} />;
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
