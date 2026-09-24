import type { ComputerStatus } from "@ardurbot/contracts";
import { Button } from "@ardurbot/ui-web";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { lazy, Suspense, useEffect, useState } from "react";
import { rpc } from "../../lib/rpc";

const Terminal = lazy(() => import("@ardurbot/ui-web/terminal"));

export function useComputerTerminal({
  computer,
  botId,
  hasControl,
  working,
  onTakeControl,
  onStop,
  onOpen,
}: {
  computer: ComputerStatus | null;
  botId?: string;
  hasControl: boolean;
  working: boolean;
  onTakeControl(): Promise<unknown>;
  onStop(): Promise<unknown>;
  onOpen(): void;
}) {
  const [tab, setTab] = useState<"screen" | "terminal">("screen");
  const [available, setAvailable] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setTab("screen");
    setFailed(false);
  }, [botId]);
  useEffect(() => {
    let cancelled = false;
    setAvailable(false);
    if (botId && computer?.computerId && computer.kind === "docker")
      void rpc.terminal
        .available({ botId, computerId: computer.computerId })
        .then((result) => {
          if (!cancelled) setAvailable(result.available);
        })
        .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [botId, computer?.computerId, computer?.kind]);
  const open = () => {
    setTab("terminal");
    onOpen();
  };
  const action = (work: () => Promise<unknown>) => {
    setFailed(false);
    void work().catch(() => setFailed(true));
  };
  const busy = working && !computer?.takeoverRequested;
  const state = !available
    ? t`Terminal is not available on this computer`
    : busy
      ? t`The bot is working — wait or stop it`
      : t`Take control to open a terminal`;
  return {
    open: available ? open : undefined,
    tabs: (
      <div
        className="flex gap-1 border-b border-border px-3 py-1"
        role="tablist"
        aria-label={t`Computer`}
      >
        <Button
          variant="ghost"
          size="sm"
          role="tab"
          aria-selected={tab === "screen"}
          onClick={() => setTab("screen")}
        >
          <Trans>Screen</Trans>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          role="tab"
          aria-selected={tab === "terminal"}
          onClick={() => setTab("terminal")}
        >
          <Trans>Terminal</Trans>
        </Button>
      </div>
    ),
    content:
      tab !== "terminal" ? null : available &&
        hasControl &&
        !busy &&
        computer?.computerId &&
        botId ? (
        <Suspense
          fallback={
            <p role="status" className="p-4 text-sm text-muted-foreground">
              <Trans>Opening terminal</Trans>
            </p>
          }
        >
          <Terminal
            key={`${computer.computerId}:${botId}`}
            close={(sessionId) =>
              rpc.terminal.close({ botId, computerId: computer.computerId!, sessionId })
            }
            ticket={(sessionId) =>
              rpc.terminal.ticket({ botId, computerId: computer.computerId!, sessionId })
            }
            labels={{
              terminal: t`Terminal`,
              reconnect: t`Reconnect`,
              opening: t`Opening terminal`,
              connecting: t`Connection lost — reconnecting`,
              ended: t`Session ended — open a new terminal`,
              newSession: t`Open a new terminal`,
              find: t`Find in terminal`,
              previous: t`Previous`,
              next: t`Next`,
            }}
          />
        </Suspense>
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
          <p role="status">{failed ? t`Terminal could not open; try again` : state}</p>
          <Button
            variant="outline"
            onClick={() =>
              !available ? setTab("screen") : busy ? action(onStop) : action(onTakeControl)
            }
          >
            {!available ? t`Back to screen` : busy ? t`Stop` : t`Take control`}
          </Button>
        </div>
      ),
  };
}
