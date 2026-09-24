import type { ComputerStatus, IdeRoot } from "@ardurbot/contracts";
import { Button } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";

const ComputerTerminalSession = lazy(() => import("../shell/terminal-session"));

export function IdeTerminal({ root }: { root: IdeRoot }) {
  const { t } = useLingui();
  const [computer, setComputer] = useState<ComputerStatus | null>(null);
  const [available, setAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const acquired = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    let live = true;
    alive.current = true;
    if (root.botId && root.computerId)
      void Promise.all([
        rpc.computer.status({ botId: root.botId }),
        rpc.terminal.available({ botId: root.botId, computerId: root.computerId }),
      ])
        .then(([status, capability]) => {
          if (live) {
            setComputer(status);
            setAvailable(capability.available);
          }
        })
        .catch((error) => {
          if (live)
            setError(
              error instanceof Error ? error.message : t`This action could not finish; try again.`,
            );
        });
    return () => {
      live = false;
      alive.current = false;
      if (acquired.current && root.botId)
        void rpc.computer.release({ botId: root.botId }).catch(() => {});
    };
  }, [root.botId, root.computerId, t]);
  if (
    available &&
    computer?.computerId === root.computerId &&
    computer.controlHolder === "user" &&
    computer.controlBotId === root.botId &&
    root.botId &&
    root.computerId
  )
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
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void rpc.computer
                .release({ botId: root.botId! })
                .then(() => {
                  acquired.current = false;
                  setComputer(null);
                })
                .catch((error) =>
                  setError(
                    error instanceof Error
                      ? error.message
                      : t`This action could not finish; try again.`,
                  ),
                )
                .finally(() => setBusy(false));
            }}
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
      <p role="status">
        {error ??
          (!available
            ? t`Terminal is not available on this computer`
            : t`Take control to open a terminal`)}
      </p>
      {available && root.botId ? (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            const botId = root.botId!;
            void (async () => {
              if (computer?.state !== "running") await rpc.computer.boot({ botId });
              await rpc.computer.takeover({ botId });
              if (!alive.current) {
                await rpc.computer.release({ botId });
                return;
              }
              acquired.current = true;
              setComputer(await rpc.computer.status({ botId }));
            })()
              .catch((error) =>
                setError(
                  error instanceof Error
                    ? error.message
                    : t`This action could not finish; try again.`,
                ),
              )
              .finally(() => setBusy(false));
          }}
        >
          {computer?.state !== "running" ? t`Open` : t`Take control`}
        </Button>
      ) : null}
    </div>
  );
}
