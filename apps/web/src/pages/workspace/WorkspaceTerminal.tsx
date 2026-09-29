import type { Bot, ComputerStatus } from "@ardurbot/contracts";
import { Button } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { lazy, Suspense } from "react";
import { userHoldsComputerControl } from "../../lib/thread-events";
import { terminalSupported, useTerminalController } from "./terminal-controller";

const ComputerTerminalSession = lazy(() => import("../shell/terminal-session"));

/**
 * Terminal tab of the workspace pane. Same authority rules as the full computer window: the
 * session renders only once the server says the terminal is available, the bot is not working
 * without a takeover request, and the user holds control. Control taken here is released when
 * the tab is left; control the user already held elsewhere is left alone.
 */
export function WorkspaceTerminal({
  bot,
  computer,
  visible,
  working,
  onTakeControl,
  onStop,
  onStart,
  onReleased,
}: {
  bot: Bot;
  computer: ComputerStatus | null;
  visible: boolean;
  working: boolean;
  onTakeControl(): Promise<unknown>;
  onStop(): Promise<unknown>;
  onStart(): Promise<unknown>;
  onReleased(): void;
}) {
  const { t } = useLingui();
  const controller = useTerminalController({
    botId: bot.id,
    computerId: computer?.computerId,
    computer,
    supported: terminalSupported(computer),
    working,
    hasControl: userHoldsComputerControl(computer, bot.id),
    visible,
    onTakeControl,
    onStop,
    onStart,
    onReleased,
    releaseOnLeave: true,
  });
  // Inactive tabs render nothing; the controller above still releases control it acquired.
  if (!visible) return null;
  if (controller.ready && computer?.computerId)
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center justify-end border-b border-border px-2 py-1">
          {controller.error ? (
            <p role="alert" className="mr-auto text-xs text-destructive">
              {controller.error}
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
          <Suspense
            fallback={
              <p
                role="status"
                className="p-4 text-sm text-muted-foreground"
              >{t`Opening terminal`}</p>
            }
          >
            <ComputerTerminalSession botId={bot.id} computerId={computer.computerId} />
          </Suspense>
        </div>
      </div>
    );
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
      <p role="status">{controller.error ?? controller.status}</p>
      {controller.actionLabel ? (
        <Button variant="outline" disabled={controller.pending} onClick={controller.runAction}>
          {controller.actionLabel}
        </Button>
      ) : null}
    </div>
  );
}
