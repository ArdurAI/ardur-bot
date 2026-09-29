import type { ComputerStatus, IdeRoot } from "@ardurbot/contracts";
import { Button } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { lazy, Suspense, useEffect, useState } from "react";
import { rpc } from "../../lib/rpc";
import { useTerminalController } from "../workspace/terminal-controller";

const ComputerTerminalSession = lazy(() => import("../shell/terminal-session"));

export function IdeTerminal({ root }: { root: IdeRoot }) {
  const { t } = useLingui();
  const [computer, setComputer] = useState<ComputerStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setComputer(null);
    setLoadError(null);
    if (root.botId && root.computerId)
      void rpc.computer
        .status({ botId: root.botId })
        .then((status) => {
          if (live) setComputer(status);
        })
        .catch((error) => {
          if (live)
            setLoadError(
              error instanceof Error ? error.message : t`This action could not finish; try again.`,
            );
        });
    return () => {
      live = false;
    };
  }, [root.botId, root.computerId, t]);
  const controller = useTerminalController({
    botId: root.botId ?? undefined,
    computerId: root.computerId ?? undefined,
    computer,
    working: false,
    hasControl:
      computer?.computerId === root.computerId &&
      computer.controlHolder === "user" &&
      computer.controlBotId === root.botId,
    onTakeControl: async () => {
      if (!root.botId) return;
      if (computer?.state !== "running") await rpc.computer.boot({ botId: root.botId });
      await rpc.computer.takeover({ botId: root.botId });
      setComputer(await rpc.computer.status({ botId: root.botId }));
    },
    onStop: async () => {},
    onReleased: () => setComputer(null),
    releaseOnLeave: true,
    bootWithTakeover: true,
  });
  const error = loadError ?? controller.error;
  if (controller.ready && root.botId && root.computerId)
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center justify-end border-b border-border px-2 py-1">
          {error ? (
            <p role="alert" className="mr-auto text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            disabled={controller.pending}
            onClick={controller.release}
          >{t`Release`}</Button>
        </div>
        <div className="min-h-0 flex-1">
          <Suspense fallback={null}>
            <ComputerTerminalSession
              botId={root.botId}
              computerId={root.computerId}
              workspace="computer"
            />
          </Suspense>
        </div>
      </div>
    );
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-sm text-muted-foreground">
      <p role="status">{error ?? controller.status}</p>
      {controller.actionLabel && root.botId ? (
        <Button variant="outline" disabled={controller.pending} onClick={controller.runAction}>
          {controller.actionLabel}
        </Button>
      ) : null}
    </div>
  );
}
