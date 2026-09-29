import type { ComputerStatus } from "@ardurbot/contracts";
import { computerCapabilities } from "@ardurbot/contracts";
import { t } from "@lingui/core/macro";
import { useEffect, useRef, useState } from "react";
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
}: {
  botId: string | undefined;
  computerId: string | undefined;
  computer: ComputerStatus | null;
  /** Client precheck; when false the availability probe is skipped and the state is unavailable. */
  supported?: boolean;
  working: boolean;
  hasControl: boolean;
  /** Surfaces that stay mounted while hidden pass their visibility so leaving releases control. */
  visible?: boolean;
  onTakeControl(): Promise<unknown>;
  onStop(): Promise<unknown>;
  onStart?(): Promise<unknown>;
  onReleased?(): void;
  releaseOnLeave: boolean;
  /** Set when the surface's take-control action boots a stopped computer first. */
  bootWithTakeover?: boolean;
}) {
  const [available, setAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // The bot whose control this surface took; only this grant is ever released.
  const acquired = useRef<string | null>(null);
  const alive = useRef(true);
  const releaseOnLeaveRef = useRef(releaseOnLeave);
  releaseOnLeaveRef.current = releaseOnLeave;
  const onReleasedRef = useRef(onReleased);
  onReleasedRef.current = onReleased;

  useEffect(() => {
    let cancelled = false;
    setAvailable(false);
    setError(null);
    if (botId && computerId && supported)
      void rpc.terminal
        .available({ botId, computerId })
        .then((result) => {
          if (!cancelled) setAvailable(result.available);
        })
        .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [botId, computerId, supported]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      const id = acquired.current;
      acquired.current = null;
      if (releaseOnLeaveRef.current && id)
        void rpc.computer
          .release({ botId: id })
          .catch(() => {})
          .then(() => onReleasedRef.current?.());
    };
  }, [botId, computerId]);

  useEffect(() => {
    if (visible) return;
    const id = acquired.current;
    acquired.current = null;
    if (releaseOnLeaveRef.current && id)
      void rpc.computer
        .release({ botId: id })
        .catch(() => {})
        .then(() => onReleasedRef.current?.());
  }, [visible]);

  const busy = working && !computer?.takeoverRequested;
  const ready = Boolean(botId && computerId) && available && hasControl && !busy;
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
    if (pending) return;
    const work = state === "working" ? onStop : state === "start" ? onStart : onTakeControl;
    if (!work) return;
    setError(null);
    setPending(true);
    void work()
      .then(() => {
        if (state !== "take-control" || !botId) return;
        // The surface went away mid-takeover: hand the grant straight back.
        if (alive.current) acquired.current = botId;
        else void rpc.computer.release({ botId }).catch(() => {});
      })
      .catch((cause) => {
        if (alive.current)
          setError(
            cause instanceof Error ? cause.message : t`This action could not finish; try again.`,
          );
      })
      .finally(() => {
        if (alive.current) setPending(false);
      });
  };

  const release = () => {
    if (pending || !botId) return;
    setError(null);
    setPending(true);
    const id = botId;
    void rpc.computer
      .release({ botId: id })
      .then(() => {
        if (acquired.current === id) acquired.current = null;
        onReleasedRef.current?.();
      })
      .catch((cause) => {
        if (alive.current)
          setError(
            cause instanceof Error ? cause.message : t`This action could not finish; try again.`,
          );
      })
      .finally(() => {
        if (alive.current) setPending(false);
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
