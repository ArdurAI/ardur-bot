import type {
  ComputerConnectionSettings,
  ComputerMode,
  ComputerStatus,
  ComputerUpdate,
  RuntimeKind,
} from "@ardurbot/contracts";
import {
  computerExecutionKind,
  computerKindFacts,
  computerRuntimeSummary,
  interruptedComputerUpdate,
} from "@ardurbot/contracts";
import { Button } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { lazy, Suspense, useEffect, useState } from "react";
import { ReleaseInterruptedComputer } from "../../components/ReleaseInterruptedComputer";
import { useComputerStateLabels } from "../../lib/computer-state-labels";
import { rpc } from "../../lib/rpc";
import { MoveToHost } from "./move-to-host";

const ComputerProfile = lazy(() =>
  import("../ComputerProfilesSettings").then((module) => ({ default: module.ComputerProfile })),
);
type Connection = { id: string; name: string; settings: ComputerConnectionSettings };

export function RuntimeBoundary({ kind, locationName }: { kind: string; locationName?: string }) {
  const { t } = useLingui();
  const summary = computerKindFacts(kind);
  if (!summary)
    return <p role="alert">{t`Computer location unavailable. Choose a supported connection.`}</p>;
  const locations = {
    Container: t`Container`,
    "This computer": t`This computer`,
    "Remote computer": t`Remote computer`,
    "Hosted sandbox": t`Hosted sandbox`,
    "Test computer": t`Test computer`,
  };
  const boundaries = {
    container: t`Separate home; can reach allowed network services and granted credentials.`,
    host: t`Runs as you; can use your files and signed-in tools`,
    account: t`Uses that account's permissions.`,
    hosted: t`Runs at the configured provider; can use granted credentials and network access.`,
    test: t`For testing only; not an isolation boundary.`,
  };
  return (
    <>
      <p>
        {locations[summary.location]}
        {locationName ? ` · ${locationName}` : ""}
      </p>
      <p className="text-muted-foreground">{boundaries[summary.boundary]}</p>
    </>
  );
}

export function RuntimeSummary({
  status,
  mode = status.mode,
  locationName,
  sharingControl,
  connectionSettings,
}: {
  status: ComputerStatus;
  mode?: ComputerMode;
  locationName?: string;
  sharingControl?: ReactNode;
  connectionSettings?: Pick<ComputerConnectionSettings, "engine">;
}) {
  const { t } = useLingui();
  const kind = computerExecutionKind({ ...status, connectionSettings });
  const summary = kind ? computerRuntimeSummary({ ...status, kind }, mode) : null;
  const states = useComputerStateLabels();
  if (!summary) return <RuntimeBoundary kind="" />;
  return (
    <div data-testid="runtime-summary" className="space-y-2 text-sm">
      <RuntimeBoundary kind={kind!} locationName={locationName} />
      {sharingControl ?? <p>{summary.scope === "bot" ? t`Only this bot` : t`Shared with team`}</p>}
      {summary.sharingWarning ? (
        <p className="text-muted-foreground">{t`Bots share files and installed tools`}</p>
      ) : null}
      <p className="text-muted-foreground">{states[summary.stateLabel]}</p>
      {status.sleepFailureReason ? (
        <p className="text-destructive">{status.sleepFailureReason}</p>
      ) : null}
    </div>
  );
}

export function BotRuntimeSettings({
  botId,
  name,
  mode,
  children,
  runtimeKind = "pi",
}: {
  botId: string;
  name: string;
  mode: ComputerMode;
  children?: ReactNode;
  runtimeKind?: RuntimeKind;
}) {
  const { t } = useLingui();
  const [data, setData] = useState<{
    status: ComputerStatus;
    connections: Connection[];
    deploymentDefault: string | null;
    updates: ComputerUpdate[];
    hostConnected: boolean;
  } | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [changing, setChanging] = useState(false);
  useEffect(() => {
    const reload = () => setRevision((value) => value + 1);
    window.addEventListener("fleet:changed", reload);
    const timer = window.setInterval(reload, 30_000);
    return () => {
      window.removeEventListener("fleet:changed", reload);
      window.clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    let active = true;
    setData((current) => (current?.status.botId === botId ? current : null));
    setError(false);
    void Promise.resolve()
      .then(() =>
        Promise.all([
          rpc.computer.status({ botId }),
          rpc.computer.connections(),
          rpc.me(),
          rpc.computer.updates(),
          rpc.host.status(),
        ]),
      )
      .then(([status, connections, me, updates, host]) => {
        if (active)
          setData({
            status,
            connections,
            updates,
            hostConnected: host.connected && me.isDeploymentOwner,

            deploymentDefault: me.sandboxProvider === "desktop" ? null : me.sandboxProvider,
          });
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [botId, mode, revision]);
  const interrupted = data ? interruptedComputerUpdate(data.status, data.updates) : undefined;
  return (
    <>
      {data ? (
        <MoveToHost
          botId={botId}
          runtimeKind={runtimeKind}
          location={{
            ...data.status,
            connectionSettings: data.connections.find(
              (entry) => entry.id === data.status.connectionId,
            )?.settings,
          }}
          hostAvailable={data.hostConnected}
          state={data.status.state}
          onChanged={async () => {
            setRevision((value) => value + 1);
            window.dispatchEvent(new Event("fleet:changed"));
          }}
        />
      ) : null}
      {data ? (
        <RuntimeSummary
          status={data.status}
          mode={mode}
          sharingControl={children}
          locationName={
            data.connections.find((entry) => entry.id === data.status.connectionId)?.name
          }
          connectionSettings={
            data.connections.find((entry) => entry.id === data.status.connectionId)?.settings
          }
        />
      ) : null}

      {interrupted ? (
        <div className="space-y-2 text-sm">
          <p role="alert">
            <Trans>The last update was interrupted.</Trans>
          </p>
          {interrupted.canReleaseReservation ? (
            <ReleaseInterruptedComputer
              key={interrupted.id}
              updateId={interrupted.id}
              onReleased={() => setRevision((value) => value + 1)}
            />
          ) : null}
        </div>
      ) : null}
      {error ? (
        <div role="alert">
          <p>{t`Computer location unavailable. Try again.`}</p>
          <Button variant="outline" onClick={() => setRevision((value) => value + 1)}>
            <Trans>Retry</Trans>
          </Button>
        </div>
      ) : null}
      {data ? (
        <details className="mt-3" onToggle={(event) => setChanging(event.currentTarget.open)}>
          <summary className="cursor-pointer text-sm">
            <Trans>Change location</Trans>
          </summary>
          {changing ? (
            <Suspense fallback={null}>
              <ComputerProfile
                choicesOnly
                botId={botId}
                name={name}
                status={data.status}
                connections={data.connections}
                deploymentDefault={data.deploymentDefault}
                hostConnected={data.hostConnected}
                runtimeKind={runtimeKind}
                onChanged={async () => {
                  setRevision((value) => value + 1);
                  window.dispatchEvent(new Event("fleet:changed"));
                }}
              />
            </Suspense>
          ) : null}
        </details>
      ) : null}
    </>
  );
}
