import type { HostStatus } from "@ardurbot/contracts";
import { hostLabel } from "@ardurbot/contracts/fleet";
import { Button } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";

export function HostComputerSettings() {
  const { t } = useLingui();
  const [status, setStatus] = useState<HostStatus>({
    configured: false,
    connected: false,
    health: null,
    roots: [],
  });
  const [roots, setRoots] = useState<string[]>([]);
  const [unavailable, setUnavailable] = useState<string[]>([]);
  /** This app keeps the folder list: a pairing it holds, or local mode. */
  const [local, setLocal] = useState(false);
  /** Local mode: no host service to set up; the Fleet row above shows this computer's state. */
  const [localMode, setLocalMode] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const desktop = window.ardurbotDesktop;
  async function refresh() {
    const [remote, host] = await Promise.all([rpc.host.status(), desktop?.host?.state()]);
    const owned = !!host?.configured || !!host?.local;
    setStatus(remote);
    setRoots(owned && host ? host.roots : remote.roots);
    setUnavailable(owned && host ? (host.unavailable ?? []) : []);
    setLocal(owned);
    setLocalMode(!!host?.local);
    setLoaded(true);
  }
  useEffect(() => {
    let active = true;
    const poll = () => {
      if (active) void refresh().catch(() => setError(t`Could not check this computer.`));
    };
    poll();
    const timer = setInterval(poll, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [t]);
  async function perform(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
    } catch {
      setError(t`Could not update this computer. Try again.`);
    } finally {
      setBusy(false);
    }
  }
  const mac = hostLabel(status.health?.platform ?? desktop?.platform ?? "") === "This Mac";
  const versions = [
    status.health?.claude.version ? `claude ${status.health.claude.version}` : "",
    status.health?.codex.version ? `codex ${status.health.codex.version}` : "",
  ].filter(Boolean);
  return (
    <section className="space-y-3 py-4" data-testid="host-computer-settings">
      <h4 className="text-sm font-medium">{mac ? t`This Mac` : t`This computer`}</h4>
      {loaded && !localMode ? (
        <p className="text-sm text-muted-foreground">
          <Trans>Host service:</Trans>{" "}
          {status.connected
            ? t`Connected`
            : status.configured
              ? t`Not running — open the desktop app`
              : t`Not set up`}
          {status.connected && versions.length ? ` · ${versions.join(" · ")}` : ""}
        </p>
      ) : null}
      {status.connected && status.health?.environment ? (
        <>
          <p className="text-sm text-muted-foreground">
            <Trans>Tools:</Trans>{" "}
            {status.health.environment.tools.map((tool) => tool.name).join(", ") ||
              t`None detected`}
          </p>
          {status.health.environment.diagnostic ? (
            <p className="text-sm text-destructive" role="alert">
              {status.health.environment.diagnostic}
            </p>
          ) : null}
        </>
      ) : null}
      {roots.length ? (
        <ul className="space-y-2">
          {roots.map((root) => (
            <li key={root} className="flex items-center justify-between gap-3 text-sm">
              <span className="break-all">
                {root}
                {unavailable.includes(root) ? (
                  <span className="block text-muted-foreground">
                    <Trans>This folder is not available.</Trans>
                  </span>
                ) : null}
              </span>
              {local && desktop?.host ? (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void perform(() => desktop.host!.removeRoot(root))}
                >
                  <Trans>Remove</Trans>
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        {loaded &&
        !localMode &&
        desktop?.host &&
        !status.connected &&
        (!status.configured || local) ? (
          <Button disabled={busy} onClick={() => void perform(() => desktop.host!.setup())}>
            <Trans>Set up</Trans>
          </Button>
        ) : null}
        {desktop?.host && local ? (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void perform(() => desktop.host!.addRoot())}
          >
            <Trans>Add folder</Trans>
          </Button>
        ) : null}
        {loaded && !localMode && status.configured ? (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                await rpc.host.disconnect();
                if (local) await desktop?.host?.clear();
              })
            }
          >
            <Trans>Disconnect this computer</Trans>
          </Button>
        ) : null}
      </div>
    </section>
  );
}
