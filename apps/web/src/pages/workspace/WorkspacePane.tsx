import type { Bot, ComputerStatus, RunActivityRow, WorkspaceContext } from "@ardurbot/contracts";
import { WorkspaceTabs } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { lazy, Suspense, useEffect, useState } from "react";
import { rpc } from "../../lib/rpc";
import { getEffectiveWorkspaceTab } from "../shell/computer-visibility";
import { terminalSupported } from "./terminal-controller";
import { WorkspaceTasks } from "./WorkspaceTasks";

const WorkspaceFiles = lazy(() =>
  import("./WorkspaceFiles").then((module) => ({ default: module.WorkspaceFiles })),
);
const WorkspaceScreen = lazy(() =>
  import("./WorkspaceScreen").then((module) => ({ default: module.WorkspaceScreen })),
);
const WorkspaceTerminal = lazy(() =>
  import("./WorkspaceTerminal").then((module) => ({ default: module.WorkspaceTerminal })),
);

export function WorkspacePane({
  bot,
  computer,
  context: suppliedContext,
  routines,
  screen,
  terminal,
  onOpenRun,
  tab,
  onTabChange,
}: {
  bot: Bot;
  computer: ComputerStatus | null;
  context?: WorkspaceContext | null;
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
}) {
  const { t } = useLingui();
  const [context, setContext] = useState<WorkspaceContext | null>(null);
  const [controlsHost, setControlsHost] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (suppliedContext !== undefined) return;
    const abort = new AbortController();
    setContext(null);
    void rpc.workspace
      .describe({ botId: bot.id }, { signal: abort.signal })
      .then((result) => {
        if (!abort.signal.aborted) setContext(result);
      })
      .catch(() => {
        if (!abort.signal.aborted) setContext(null);
      });
    return () => abort.abort();
  }, [
    bot.id,
    computer?.computerId,
    computer?.connectionId,
    computer?.kind,
    computer?.state,
    computer?.homeRevision,
    suppliedContext,
  ]);
  const describedContext = suppliedContext === undefined ? context : suppliedContext;
  const currentContext =
    describedContext?.botId === bot.id &&
    describedContext.computerId === (computer?.computerId ?? null)
      ? describedContext
      : null;
  const filesAvailable = currentContext?.files !== "unavailable" && currentContext?.computerId;
  const terminalAvailable = terminal !== null && terminalSupported(computer);
  const selected = getEffectiveWorkspaceTab(
    tab,
    computer?.capabilities?.graphical,
    !!filesAvailable,
    terminalAvailable,
  );
  const tabs = [
    {
      id: "tasks",
      label: t`Tasks`,
      content: (
        <WorkspaceTasks
          key={bot.id}
          botId={bot.id}
          visible={selected === "tasks"}
          onOpenRun={onOpenRun}
        />
      ),
    },
    ...(filesAvailable
      ? [
          {
            id: "files",
            label: t`Files`,
            content: (
              <Suspense fallback={null}>
                <WorkspaceFiles bot={bot} context={currentContext} />
              </Suspense>
            ),
          },
        ]
      : []),
    ...(terminal && terminalAvailable
      ? [
          {
            id: "terminal",
            label: t`Terminal`,
            content: (
              <Suspense fallback={null}>
                <WorkspaceTerminal
                  key={bot.id}
                  bot={bot}
                  computer={computer}
                  visible={selected === "terminal"}
                  working={terminal.working}
                  onTakeControl={terminal.onTakeControl}
                  onStop={terminal.onStop}
                  onStart={terminal.onStart}
                  onReleased={terminal.onReleased}
                  controlsHost={controlsHost}
                  registerCloseGuard={terminal.registerCloseGuard}
                />
              </Suspense>
            ),
          },
        ]
      : []),
    { id: "routines", label: t`Routines`, content: routines },
    ...(computer?.capabilities?.graphical === true
      ? [
          {
            id: "screen",
            label: t`Screen`,
            content: (
              <Suspense fallback={null}>
                <WorkspaceScreen {...screen} visible={selected === "screen"} />
              </Suspense>
            ),
          },
        ]
      : [
          {
            id: "computer",
            label: t`Computer`,
            content: (
              <Suspense fallback={null}>
                <WorkspaceScreen {...screen} visible={selected === "computer"} />
              </Suspense>
            ),
          },
        ]),
  ];
  return (
    <>
      <div ref={setControlsHost} />
      <WorkspaceTabs tabs={tabs} value={selected} onChange={onTabChange} />
    </>
  );
}
