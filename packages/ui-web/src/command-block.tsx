import type { CommandBlock as RecordedCommand } from "@ardurbot/core";
import { commandOutput, commandSummary } from "@ardurbot/core";
import type { ReactNode } from "react";
import { useId, useState } from "react";
import { Button } from "./components/ui/button.js";

export type CommandBlockLabels = {
  copyCommand: string;
  copyOutput: string;
  exportRun: string;
  exportBlock: string;
  rerun: string;
  share: string;
  search: string;
  notRecorded: string;
  incomplete: string;
  copyFailed: string;
};

export function CommandBlock({
  block,
  labels,
  onExpand,
  onExportRun,
  onExportBlock,
  onRerun,
  rerunPending = false,
  onShare,
  search,
}: {
  block: RecordedCommand;
  labels: CommandBlockLabels;
  onExpand?: () => void;
  onExportRun?: () => void;
  onExportBlock?: () => void;
  onRerun?: () => void;
  rerunPending?: boolean;
  onShare?: () => void;
  search?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [opened, setOpened] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const id = useId();
  const copy = (text: string) => {
    setCopyFailed(false);
    void navigator.clipboard.writeText(text).catch(() => setCopyFailed(true));
  };
  return (
    <section
      data-testid="command-block"
      className="w-full min-w-0 rounded-lg border border-border bg-card text-card-foreground"
    >
      <Button
        variant="ghost"
        className="h-auto w-full justify-start gap-2 p-3 text-start font-normal"
        aria-expanded={expanded}
        aria-controls={id}
        onClick={() => {
          setExpanded(!expanded);
          setOpened(true);
          if (!expanded) onExpand?.();
        }}
      >
        <span aria-hidden="true">{expanded ? "−" : "+"}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={commandSummary(block)}>
          {commandSummary(block)}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{block.outcome}</span>
      </Button>
      <div className="px-3 pb-2 text-xs text-muted-foreground">
        <time dateTime={block.startedAt ?? undefined}>{block.startedAt ?? labels.notRecorded}</time>
        {block.outcome === "unknown" ? <span> · {labels.incomplete}</span> : null}
      </div>
      <div
        id={id}
        inert={!expanded}
        aria-hidden={!expanded}
        className="grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none"
        style={{ gridTemplateRows: expanded ? "1fr" : "0fr" }}
      >
        <div className="min-h-0 overflow-hidden">
          {opened ? (
            <div className="space-y-3 border-t border-border p-3">
              <p className="break-all text-xs text-muted-foreground">
                {block.computer ?? labels.notRecorded}
              </p>
              <pre
                // biome-ignore lint/a11y/noNoninteractiveTabindex: The output scroller must be keyboard accessible.
                tabIndex={0}
                className="max-h-80 overflow-auto whitespace-pre-wrap break-all font-mono text-xs"
              >
                {commandOutput(block)}
              </pre>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={block.command === null}
                  onClick={() => copy(block.command ?? "")}
                >
                  {labels.copyCommand}
                </Button>
                <Button size="sm" variant="outline" onClick={() => copy(commandOutput(block))}>
                  {labels.copyOutput}
                </Button>
                {onExportBlock ? (
                  <Button size="sm" variant="outline" onClick={onExportBlock}>
                    {labels.exportBlock}
                  </Button>
                ) : null}
                {onExportRun ? (
                  <Button size="sm" variant="outline" onClick={onExportRun}>
                    {labels.exportRun}
                  </Button>
                ) : null}
                {onShare ? (
                  <Button size="sm" variant="outline" onClick={onShare}>
                    {labels.share}
                  </Button>
                ) : null}
                {onRerun ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={rerunPending || Boolean(block.rerunDisabledReason)}
                    onClick={onRerun}
                  >
                    {labels.rerun}
                  </Button>
                ) : null}
              </div>
              {onRerun && block.rerunDisabledReason ? (
                <p className="text-xs text-muted-foreground">{block.rerunDisabledReason}</p>
              ) : null}
              {copyFailed ? (
                <p role="alert" className="text-xs text-destructive">
                  {labels.copyFailed}
                </p>
              ) : null}
              {search}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
