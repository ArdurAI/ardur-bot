import type { Bot, ComputerStatus } from "@ardurbot/contracts";
import { terminalCollectionKey } from "@ardurbot/core";
import { Button } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { lazy, Suspense, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { userHoldsComputerControl } from "../../lib/thread-events";
import { terminalSupported, useTerminalController } from "./terminal-controller";
import { useUnsavedChanges } from "./unsaved";

const TerminalCollection = lazy(() => import("./TerminalCollection"));

/**
 * Terminal tab of the workspace pane. Same authority rules as the full computer window: the
 * session renders only once the server says the terminal is available, the bot is not working
 * without a takeover request, and the user holds control. Hiding retains the renderer and grant;
 * closing releases only control acquired here, leaving pre-existing grants alone.
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
  controlsHost,
  registerCloseGuard,
  userId,
}: {
  bot: Bot;
  computer: ComputerStatus | null;
  visible: boolean;
  working: boolean;
  onTakeControl(): Promise<unknown>;
  onStop(): Promise<unknown>;
  onStart(): Promise<unknown>;
  onReleased(): void;
  controlsHost?: HTMLElement | null;
  registerCloseGuard?(guard: (() => boolean) | null): void;
  userId?: string;
}) {
  const { t } = useLingui();
  const storageKey =
    userId && computer?.computerId && computer.computerGeneration !== undefined
      ? terminalCollectionKey({
          userId,
          spaceId: bot.spaceId,
          botId: bot.id,
          computerId: computer.computerId,
          generation: computer.computerGeneration,
        })
      : undefined;
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
    keepControlWhileHidden: true,
    preserveOnReload: Boolean(storageKey),
  });
  const identity = `${storageKey ?? "unscoped"}:${bot.id}:${computer?.computerId}:${computer?.computerGeneration ?? "unknown"}`;
  const [opened, setOpened] = useState<string | null>(null);
  if (visible && controller.ready && opened !== identity) setOpened(identity);
  const sessionOpen = opened === identity && controller.ready;
  useUnsavedChanges(sessionOpen, t`End this terminal?`, controller.pending);
  useLayoutEffect(() => {
    registerCloseGuard?.(
      sessionOpen ? () => !controller.pending && window.confirm(t`End this terminal?`) : null,
    );
    return () => registerCloseGuard?.(null);
  }, [registerCloseGuard, sessionOpen, controller.pending, t]);
  // Unvisited terminals stay lazy; only an existing renderer survives hiding.
  if (controller.ready && computer?.computerId && (visible || opened === identity)) {
    const controls = (
      <div className="flex items-center justify-end gap-2 border-b border-border px-2 py-1">
        <span className="mr-auto text-xs text-muted-foreground">{t`You control the computer`}</span>
        {controller.error ? (
          <p role="alert" className="text-xs text-destructive">
            {controller.error}
          </p>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          disabled={controller.pending}
          onClick={() => {
            if (window.confirm(t`End this terminal?`)) controller.release();
          }}
        >{t`Release`}</Button>
      </div>
    );
    return (
      <div className="flex h-full min-h-0 flex-col">
        {controlsHost ? createPortal(controls, controlsHost) : controls}
        <div className="min-h-0 flex-1">
          <Suspense
            fallback={
              <p
                role="status"
                className="p-4 text-sm text-muted-foreground"
              >{t`Opening terminal`}</p>
            }
          >
            <TerminalCollection
              key={identity}
              botId={bot.id}
              computerId={computer.computerId}
              visible={visible}
              onCloseLast={controller.release}
              storageKey={storageKey}
              releaseOnDisconnect={controller.ownsControl}
            />
          </Suspense>
        </div>
      </div>
    );
  }
  if (!visible) return null;
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
