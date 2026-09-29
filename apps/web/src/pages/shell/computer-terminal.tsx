import type { ComputerStatus } from "@ardurbot/contracts";
import { Button } from "@ardurbot/ui-web";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { terminalSupported, useTerminalController } from "../workspace/terminal-controller";

const ComputerTerminalSession = lazy(() => import("./terminal-session"));

export function useComputerTerminal({
  computer,
  botId,
  hasControl,
  working,
  open: computerOpen,
  onTakeControl,
  onStop,
  onOpen,
  onTabChange,
}: {
  computer: ComputerStatus | null;
  botId?: string;
  hasControl: boolean;
  working: boolean;
  open?: boolean;
  onTakeControl(): Promise<unknown>;
  onStop(): Promise<unknown>;
  onOpen(): void;
  onTabChange?: (tab: "screen" | "terminal") => void;
}) {
  const [tab, setTab] = useState<"screen" | "terminal">("screen");
  const onTabChangeRef = useRef(onTabChange);
  onTabChangeRef.current = onTabChange;

  const selectTab = (nextTab: "screen" | "terminal") => {
    setTab(nextTab);
    onTabChangeRef.current?.(nextTab);
  };

  useEffect(() => {
    selectTab("screen");
  }, [botId]);
  useEffect(() => {
    if (computerOpen === false) {
      selectTab("screen");
    }
  }, [computerOpen]);
  const controller = useTerminalController({
    botId,
    computerId: computer?.computerId,
    computer,
    supported: terminalSupported(computer),
    working,
    hasControl,
    onTakeControl,
    onStop,
    // The full window owns its control lifecycle; closing it must not release control here.
    releaseOnLeave: false,
  });
  const open = () => {
    selectTab("terminal");
    onOpen();
  };
  return {
    tab,
    open: controller.available ? open : undefined,
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
          onClick={() => selectTab("screen")}
        >
          <Trans>Screen</Trans>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          role="tab"
          aria-selected={tab === "terminal"}
          onClick={() => selectTab("terminal")}
        >
          <Trans>Terminal</Trans>
        </Button>
      </div>
    ),
    content:
      tab !== "terminal" ? null : controller.ready && computer?.computerId && botId ? (
        <Suspense
          fallback={
            <p role="status" className="p-4 text-sm text-muted-foreground">{t`Opening terminal`}</p>
          }
        >
          <ComputerTerminalSession botId={botId} computerId={computer.computerId} />
        </Suspense>
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
          <p role="status">
            {controller.error ? t`Terminal could not open; try again` : controller.status}
          </p>
          <Button
            variant="outline"
            disabled={controller.pending}
            onClick={() =>
              controller.state === "unavailable" ? selectTab("screen") : controller.runAction()
            }
          >
            {controller.state === "unavailable" ? t`Back to screen` : controller.actionLabel}
          </Button>
        </div>
      ),
  };
}
