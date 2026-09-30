import type { ComputerStatus } from "@ardurbot/contracts";
import { computerCapabilities } from "@ardurbot/contracts";
import { t } from "@lingui/core/macro";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { rpc } from "../../lib/rpc";

/**
 * Client-side support precheck for an interactive terminal. The server capability summary wins;
 * the kind table is the fallback for older servers that do not send one. Either way the server
 * still authorizes every ticket, so this only decides whether the tab is offered at all.
 */
export function terminalSupported(computer: ComputerStatus | null | undefined): boolean {
  if (!computer?.computerId) return false;
  return (
    computer.capabilities?.interactiveTerminal ??
    computerCapabilities(computer.kind).interactiveTerminal
  );
}

export type TerminalControllerState =
  | "unavailable"
  | "working"
  | "start"
  | "take-control"
  | "ready";

/**
 * The single terminal session controller shared by the workspace pane, the full computer window
 * and the IDE. It owns the availability probe, the working/control state machine, the shared
 * status copy, and — for surfaces that opt in — releasing exactly the control it acquired when
 * the surface is left or unmounted. It never renders or connects a session itself; surfaces
 * mount the lazy terminal only when `ready` is true.
 */
export function useTerminalController({
  botId,
  computerId,
  computer,
  supported = true,
  working,
  hasControl,
  visible = true,
  onTakeControl,
  onStop,
  onStart,
  onReleased,
  releaseOnLeave,
  bootWithTakeover = false,
  keepControlWhileHidden = false,
}: {
  botId: string | undefined;
  computerId: string | undefined;
  computer: ComputerStatus | null;
  /** Client precheck; when false the availability probe is skipped and the state is unavailable. */
  supported?: boolean;
  working: boolean;
  hasControl: boolean;
  /** Visibility dismisses pending takeovers; acquired grants follow the hidden-control policy. */
  visible?: boolean;
  onTakeControl(): Promise<unknown>;
  onStop(): Promise<unknown>;
  onStart?(): Promise<unknown>;
  onReleased?(): void;
  releaseOnLeave: boolean;
  /** Preserve an acquired grant across view changes, but not explicit close. */
  keepControlWhileHidden?: boolean;
  /** Set when the surface's take-control action boots a stopped computer first. */
  bootWithTakeover?: boolean;
}) {
  const [availability, setAvailability] = useState<{
    botId: string;
    computerId: string;
    available: boolean;
  } | null>(null);
  const available = Boolean(
    supported &&
      availability &&
      availability.botId === botId &&
      availability.computerId === computerId &&
      availability.available,
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [releasing, setReleasing] = useState(false);
  // Old completions retain their own lifetime and callbacks, even on an A/B/A switch.
  const lifetime = useMemo(
    () => ({
      botId,
      computerId,
      alive: true,
      visible: true,
      hidden: 0,
      held: false,
      acquired: null as null | (() => void),
    }),
    [botId, computerId],
  );
  useLayoutEffect(() => {
    if (!visible && lifetime.visible) lifetime.hidden++;
    lifetime.visible = visible;
    if (hasControl) lifetime.held = true;
    else if (lifetime.held) {
      lifetime.acquired = null;
      lifetime.held = false;
      setReleasing(false);
    }
  }, [lifetime, visible, hasControl]);

  useEffect(() => {
    let cancelled = false;
    setAvailability(null);
    setError(null);
    if (botId && computerId && supported)
      void rpc.terminal
        .available({ botId, computerId })
        .then((result) => {
          if (!cancelled) setAvailability({ botId, computerId, available: result.available });
        })
        .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [botId, computerId, supported]);

  useEffect(() => {
    lifetime.alive = true;
    setPending(false);
    setReleasing(false);
    return () => {
      lifetime.alive = false;
      const releaseAcquired = lifetime.acquired;
      lifetime.acquired = null;
      if (releaseOnLeave) releaseAcquired?.();
    };
  }, [lifetime, releaseOnLeave]);

  useEffect(() => {
    if (visible || keepControlWhileHidden || !releaseOnLeave) return;
    const releaseAcquired = lifetime.acquired;
    lifetime.acquired = null;
    releaseAcquired?.();
  }, [lifetime, visible, keepControlWhileHidden, releaseOnLeave]);

  const busy = working && !computer?.takeoverRequested;
  const ready =
    Boolean(botId && computerId) &&
    available &&
    hasControl &&
    !busy &&
    computer?.state === "running" &&
    !releasing;
  const state: TerminalControllerState = !available
    ? "unavailable"
    : busy
      ? "working"
      : computer?.state !== "running" && onStart
        ? "start"
        : !hasControl
          ? "take-control"
          : "ready";
  const status =
    state === "unavailable"
      ? t`Terminal is not available on this computer`
      : state === "working"
        ? t`The bot is working — wait or stop it`
        : state === "start"
          ? t`Start computer to open a terminal`
          : t`Take control to open a terminal`;
  const actionLabel =
    state === "unavailable"
      ? null
      : state === "working"
        ? t`Stop`
        : state === "start"
          ? t`Start computer`
          : bootWithTakeover && computer?.state !== "running"
            ? t`Open`
            : t`Take control`;

  const runAction = () => {
    if (pending || !visible) return;
    const work = state === "working" ? onStop : state === "start" ? onStart : onTakeControl;
    if (!work) return;
    setError(null);
    setPending(true);
    const hidden = lifetime.hidden;
    const returnGrant = () => {
      if (!botId) return;
      void rpc.computer
        .release({ botId })
        .then(() => onReleased?.())
        .catch(() => {});
    };
    void work()
      .then(() => {
        if (state !== "take-control" || !botId || hasControl) return;
        // The surface went away mid-takeover: hand the grant straight back.
        if (lifetime.alive && lifetime.visible && lifetime.hidden === hidden)
          lifetime.acquired = returnGrant;
        else returnGrant();
      })
      .catch((cause) => {
        if (lifetime.alive)
          setError(
            cause instanceof Error ? cause.message : t`This action could not finish; try again.`,
          );
      })
      .finally(() => {
        if (lifetime.alive) setPending(false);
      });
  };

  const release = () => {
    if (pending || !botId) return;
    setError(null);
    setPending(true);
    const releaseAcquired = lifetime.acquired;
    lifetime.acquired = null;
    const id = botId;
    void rpc.computer
      .release({ botId: id })
      .then(() => {
        lifetime.acquired = null;
        if (lifetime.alive) setReleasing(true);
        onReleased?.();
      })
      .catch((cause) => {
        if (lifetime.alive) {
          lifetime.acquired = releaseAcquired;
          setReleasing(false);
          setError(
            cause instanceof Error ? cause.message : t`This action could not finish; try again.`,
          );
        }
      })
      .finally(() => {
        if (lifetime.alive) setPending(false);
      });
  };

  return {
    supported,
    available,
    busy,
    ready,
    state,
    status,
    actionLabel,
    error,
    pending,
    runAction,
    release,
  };
}
