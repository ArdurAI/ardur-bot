import type {
  Bot,
  ComputerStatus,
  RunActivityRow,
  WorkspaceContext,
  WorkspaceView,
} from "@ardurbot/contracts";
import { terminalCollectionKey } from "@ardurbot/core";
import { Button, WorkspaceTabs } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { ArrowLeft, Maximize2, Minimize2, X } from "lucide-react";
import type { ReactNode } from "react";
import { Suspense, useEffect, useState } from "react";
import { Shimmer } from "../../components/ai/primitives";
import { rpc } from "../../lib/rpc";
import type { ChangeLocation } from "./change-target";
import { readTerminalCollection } from "./terminal-state";
import { availableWorkspaceViews, isWorkspaceViewId, workspaceViews } from "./view-registry";

export function WorkspacePane({
  bot,
  computer,
  context: suppliedContext,
  contextLoading: suppliedContextLoading = false,
  onContextChange,
  routines,
  screen,
  terminal,
  onOpenRun,
  tab,
  onTabChange,
  openViews,
  expanded = false,
  onExpand,
  onClose,
  onRetry,
  visible = true,
  headerActions,
  allowTerminalStart = true,
  onBackToChat,
  hiddenControlsHost,
  compact = false,
  fileLocation,
  changeLocation,
}: WorkspacePaneProps) {
  const { t } = useLingui();
  const [context, setContext] = useState<{
    key: string;
    value: WorkspaceContext | null;
  } | null>(null);
  const [controlsHost, setControlsHost] = useState<HTMLDivElement | null>(null);
  const [revision, setRevision] = useState(0);
  const contextKey = JSON.stringify([
    bot.id,
    computer?.computerId,
    computer?.connectionId,
    computer?.kind,
    computer?.state,
    computer?.homeRevision,
    revision,
  ]);
  useEffect(() => {
    if (suppliedContext !== undefined) return;
    const abort = new AbortController();
    setContext(null);
    void rpc.workspace
      .describe({ botId: bot.id }, { signal: abort.signal })
      .then((result) => {
        if (!abort.signal.aborted) setContext({ key: contextKey, value: result });
      })
      .catch(() => {
        if (!abort.signal.aborted) setContext({ key: contextKey, value: null });
      });
    return () => abort.abort();
  }, [bot.id, contextKey, suppliedContext]);
  const contextLoading =
    suppliedContext === undefined ? context?.key !== contextKey : suppliedContextLoading;
  const describedContext = suppliedContext === undefined ? context?.value : suppliedContext;
  const currentContext =
    !contextLoading &&
    describedContext?.botId === bot.id &&
    describedContext.computerId === (computer?.computerId ?? null)
      ? describedContext
      : null;
  const capabilities = { computer, context: currentContext, terminal: terminal !== null };
  const selected = isWorkspaceViewId(tab) ? tab : "tasks";
  const views =
    openViews ?? availableWorkspaceViews(capabilities).map((view) => ({ type: view.id }));
  const opened = views.some((view) => view.type === selected)
    ? views
    : [...views, { type: selected }];
  const name = workspaceViews[selected].label(t);
  const canRestoreTerminal = Boolean(
    terminal?.userId &&
      computer?.computerId &&
      computer.computerGeneration !== undefined &&
      readTerminalCollection(
        terminalCollectionKey({
          userId: terminal.userId,
          spaceId: bot.spaceId,
          botId: bot.id,
          computerId: computer.computerId,
          generation: computer.computerGeneration,
        }),
      ),
  );
  const closeLabel = (name: string) => t`Close ${name}`;
  const tabs = opened.map(({ type }) => {
    const view = workspaceViews[type];
    return {
      id: type,
      contentId: type === "files" || type === "ide" ? "editor" : type,
      label: view.label(t),
      content:
        (type === "files" || type === "ide" || type === "changes") && contextLoading ? (
          <div
            role="status"
            className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground"
          >
            <Shimmer>{t`Loading…`}</Shimmer>
          </div>
        ) : type === "terminal" &&
          view.available(capabilities) &&
          !allowTerminalStart &&
          !canRestoreTerminal ? (
          <div className="flex h-full items-center justify-center p-6">
            <Button
              variant="outline"
              onClick={() => onTabChange("terminal")}
            >{t`Open terminal`}</Button>
          </div>
        ) : view.available(capabilities) ? (
          <Suspense fallback={null}>
            {view.render({
              bot,
              computer,
              context: currentContext,
              onContextChange: (next) => {
                if (suppliedContext !== undefined) onContextChange?.(next);
                else setContext({ key: contextKey, value: next });
              },
              routines,
              screen,
              terminal,
              onOpenRun,
              visible: visible && selected === type,
              controlsHost: !visible && hiddenControlsHost ? hiddenControlsHost : controlsHost,
              compact,
              fileLocation,
              changeLocation,
            })}
          </Suspense>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
            <p role="status">{view.unavailable(t)}</p>
            <Button
              variant="outline"
              onClick={() => {
                setRevision((value) => value + 1);
                onRetry?.();
              }}
            >{t`Retry`}</Button>
          </div>
        ),
    };
  });
  return (
    <>
      <div
        data-workspace-chrome
        className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-2"
      >
        <h2 className="mr-auto text-sm font-medium">{name}</h2>
        {onBackToChat ? (
          <Button variant="ghost" size="sm" onClick={onBackToChat}>
            <ArrowLeft size={16} className="rtl:rotate-180" />
            {t`Back to chat`}
          </Button>
        ) : null}
        {headerActions}
        {onExpand ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={expanded ? t`Back to chat` : t`Expand`}
            onClick={onExpand}
          >
            {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </Button>
        ) : null}
        {onClose ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={closeLabel(name)}
            onClick={() => onClose(selected)}
          >
            <X size={16} />
          </Button>
        ) : null}
      </div>
      <div ref={setControlsHost} />
      <div className="flex min-h-0 flex-1 flex-col">
        <WorkspaceTabs
          label={t`Views`}
          tabs={tabs}
          value={selected}
          onChange={onTabChange}
          onClose={onClose}
          closeLabel={closeLabel}
        />
      </div>
    </>
  );
}

export type WorkspacePaneProps = {
  bot: Bot;
  computer: ComputerStatus | null;
  context?: WorkspaceContext | null;
  contextLoading?: boolean;
  onContextChange?(context: WorkspaceContext): void;
  routines: ReactNode;
  screen: {
    computer: ComputerStatus | null;
    open: boolean;
    url: string | null;
    error: ReactNode;
    status?: ReactNode;
    onOpen(): void;
  };
  terminal: {
    userId?: string;
    working: boolean;
    onTakeControl(): Promise<unknown>;
    onStop(): Promise<unknown>;
    onStart(): Promise<unknown>;
    onReleased(): void;
    registerCloseGuard?(guard: (() => boolean) | null): void;
  } | null;
  onOpenRun(run: RunActivityRow): void;
  tab: string;
  onTabChange(tab: string): void;
  openViews?: readonly WorkspaceView[];
  expanded?: boolean;
  visible?: boolean;
  onExpand?(): void;
  onClose?(tab: string): void;
  onRetry?(): void;
  headerActions?: ReactNode;
  allowTerminalStart?: boolean;
  onBackToChat?(): void;
  hiddenControlsHost?: HTMLElement | null;
  compact?: boolean;
  fileLocation?: { path: string; line?: number; requestId: number };
  changeLocation?: ChangeLocation;
};
