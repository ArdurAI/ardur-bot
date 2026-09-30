import type { ComputerConnectionSettings, ComputerMode, ComputerStatus } from "@ardurbot/contracts";
import { COMPUTER_STATES, computerKindFacts, computerRuntimeSummary } from "@ardurbot/contracts";
import { Button } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { lazy, Suspense, useEffect, useState } from "react";
import { rpc } from "../../lib/rpc";

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
}: {
  status: ComputerStatus;
  mode?: ComputerMode;
  locationName?: string;
}) {
  const { t } = useLingui();
  const summary = computerRuntimeSummary(status, mode);
  if (!summary) return <RuntimeBoundary kind={status.kind} />;
  const states = {
    [COMPUTER_STATES.stopped]: t`Stopped`,
    [COMPUTER_STATES.booting]: t`Starting`,
    [COMPUTER_STATES.running]: t`Running`,
    [COMPUTER_STATES.suspending]: t`Paused for an update`,
    [COMPUTER_STATES.suspended]: t`Sleeping`,
    [COMPUTER_STATES.error]: t`Could not start`,
  };
  return (
    <div data-testid="runtime-summary" className="space-y-2 text-sm">
      <RuntimeBoundary kind={status.kind} locationName={locationName} />
      <p>{summary.scope === "bot" ? t`Only this bot` : t`Shared with team`}</p>
      {summary.sharingWarning ? (
        <p className="text-muted-foreground">{t`Bots share files and installed tools`}</p>
      ) : null}
      <p className="text-muted-foreground">{states[summary.stateLabel]}</p>
    </div>
  );
}

export function BotRuntimeSettings({
  botId,
  name,
  mode,
}: {
  botId: string;
  name: string;
  mode: ComputerMode;
}) {
  const { t } = useLingui();
  const [data, setData] = useState<{
    status: ComputerStatus;
    connections: Connection[];
    deploymentDefault: string | null;
    teamStatus?: ComputerStatus;
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
          rpc.computer.list(),
        ]),
      )
      .then(([status, connections, me, computers]) => {
        if (active)
          setData({
            status,
            connections,
            teamStatus: computers.find((entry) => entry.status.mode === "team")?.status,
            deploymentDefault:
              me.sandboxProvider === "docker" && me.computerHost === "this-mac"
                ? null
                : me.sandboxProvider,
          });
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [botId, mode, revision]);
  return (
    <>
      {data ? (
        <RuntimeSummary
          status={data.status}
          locationName={
            data.connections.find((entry) => entry.id === data.status.connectionId)?.name ??
            (data.status.kind === "desktop" ? undefined : data.status.kind)
          }
        />
      ) : null}
      {data && mode === "team" && data.status.mode !== mode && data.teamStatus ? (
        <RuntimeBoundary
          kind={data.teamStatus.kind}
          locationName={
            data.connections.find((entry) => entry.id === data.teamStatus?.connectionId)?.name
          }
        />
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
                botId={botId}
                name={name}
                status={data.status}
                connections={data.connections}
                deploymentDefault={data.deploymentDefault}
                onChanged={async () => setRevision((value) => value + 1)}
              />
            </Suspense>
          ) : null}
        </details>
      ) : null}
    </>
  );
}
