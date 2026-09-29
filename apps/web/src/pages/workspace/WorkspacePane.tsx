import type { Bot, ComputerStatus, RunActivityRow, WorkspaceContext } from "@ardurbot/contracts";
import { WorkspaceTabs } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { lazy, Suspense, useEffect, useState } from "react";
import { rpc } from "../../lib/rpc";
import { getEffectiveWorkspaceTab } from "../shell/computer-visibility";
import { WorkspaceTasks } from "./WorkspaceTasks";

const WorkspaceFiles = lazy(() =>
  import("./WorkspaceFiles").then((module) => ({ default: module.WorkspaceFiles })),
);
const WorkspaceScreen = lazy(() =>
  import("./WorkspaceScreen").then((module) => ({ default: module.WorkspaceScreen })),
);

export function WorkspacePane({
  bot,
  computer,
  routines,
  screen,
  onOpenRun,
  tab,
  onTabChange,
}: {
  bot: Bot;
  computer: ComputerStatus | null;
  routines: ReactNode;
  screen: {
    computer: ComputerStatus | null;
    open: boolean;
    url: string | null;
    error: ReactNode;
    status?: ReactNode;
    onOpen(): void;
  };
  onOpenRun(run: RunActivityRow): void;
  tab: string;
  onTabChange(tab: string): void;
}) {
  const { t } = useLingui();
  const [context, setContext] = useState<WorkspaceContext | null>(null);
  useEffect(() => {
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
  }, [bot.id, computer?.computerId, computer?.state, computer?.homeRevision]);
  const currentContext =
    context?.botId === bot.id && context.computerId === (computer?.computerId ?? null)
      ? context
      : null;
  const filesAvailable = currentContext?.files !== "unavailable" && currentContext?.computerId;
  const selected = getEffectiveWorkspaceTab(
    tab,
    computer?.capabilities?.graphical,
    !!filesAvailable,
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
  return <WorkspaceTabs tabs={tabs} value={selected} onChange={onTabChange} />;
}
