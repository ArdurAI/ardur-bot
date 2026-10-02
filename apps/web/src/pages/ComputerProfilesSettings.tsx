import type {
  ComputerConnectionSettings,
  ComputerProfileId,
  ComputerStatus,
  Me,
  RuntimeKind,
} from "@ardurbot/contracts";
import {
  COMPUTER_PROFILES,
  computerConnectionKind,
  computerExecutionKind,
  computerKindFacts,
  recommendedContainer,
  runtimeSupportsLocation,
} from "@ardurbot/contracts";
import { ENGINE_LABELS } from "@ardurbot/contracts/fleet";
import { computerRefusalMessage } from "@ardurbot/core";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  NativeSelect,
  NativeSelectOption,
} from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
import { ComputerLocationPicker } from "./shell/computer-location-picker";
import { MoveToHost } from "./shell/move-to-host";
import { RuntimeBoundary, RuntimeSummary } from "./shell/runtime-summary";

type Connection = { id: string; name: string; settings: ComputerConnectionSettings };

/** The optional sandbox engine, independent of the new-bot location default. */
export function deploymentDefaultEngine(
  me: Pick<Me, "computerHost" | "sandboxProvider">,
): string | null {
  return me.sandboxProvider === "desktop" ? null : me.sandboxProvider;
}

const DEPLOYMENT_DEFAULT = "deployment-default";
const HOST_COMPUTER = "host-computer";

export function ComputerProfilesSettings() {
  const { t } = useLingui();
  const [computers, setComputers] = useState<
    { botId: string; name: string; runtimeKind?: RuntimeKind; status: ComputerStatus }[]
  >([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [deploymentDefault, setDeploymentDefault] = useState<string | null>("docker");
  const [hostConnected, setHostConnected] = useState(false);
  const [error, setError] = useState("");
  async function refresh() {
    const [computers, connections, me, host] = await Promise.all([
      rpc.computer.list(),
      rpc.computer.connections(),
      rpc.me(),
      rpc.host.status(),
    ]);
    setComputers(computers);
    setConnections(connections);
    setDeploymentDefault(deploymentDefaultEngine(me));
    setHostConnected(host.connected && me.isDeploymentOwner);
  }
  useEffect(() => {
    const reload = () =>
      void refresh().catch(() => setError(t`Computers are unavailable; reconnect and try again.`));
    reload();
    window.addEventListener("fleet:changed", reload);
    return () => window.removeEventListener("fleet:changed", reload);
  }, []);
  return (
    <div className="space-y-4" data-testid="computer-profiles-settings">
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
      {computers.map((computer) => (
        <ComputerProfile
          key={computer.status.computerId}
          {...computer}
          connections={connections}
          deploymentDefault={deploymentDefault}
          hostConnected={hostConnected}
          onChanged={refresh}
        />
      ))}
    </div>
  );
}

export function ComputerProfile({
  botId,
  name,
  status,
  connections,
  deploymentDefault = "docker",
  onChanged,
  choicesOnly = false,
  runtimeKind = "pi",
  hostConnected = false,
}: {
  botId: string;
  name: string;
  status: ComputerStatus;
  connections: Connection[];
  deploymentDefault?: string | null;
  onChanged: () => Promise<void>;
  choicesOnly?: boolean;
  runtimeKind?: RuntimeKind;
  hostConnected?: boolean;
}) {
  const { t } = useLingui();
  const savedConnectionId = status.connectionId ?? "";
  const [profile, setProfile] = useState<ComputerProfileId>(status.imageProfile ?? "base");
  const [selection, setSelection] = useState(savedConnectionId);
  useEffect(() => {
    setSelection(status.connectionId ?? "");
  }, [status.connectionId, status.kind]);
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const connection = connections.find((entry) => entry.id === selection);
  const choosingDefault = selection === DEPLOYMENT_DEFAULT;
  const choosingHost = selection === HOST_COMPUTER;
  // Local Docker and saved connections answer a probe; other engines are named by their kind.
  const probed =
    choosingHost ||
    !runtimeSupportsLocation(runtimeKind, {
      kind: status.kind,
      connectionId: status.connectionId,
      connectionSettings: connections.find((entry) => entry.id === status.connectionId)?.settings,
    })
      ? null
      : choosingDefault
        ? deploymentDefault === "docker"
          ? ""
          : null
        : selection || (status.kind === "docker" ? "" : null);
  const [engineError, setEngineError] = useState("");
  const [engineRefresh, setEngineRefresh] = useState(0);
  const [detectedEngine, setDetectedEngine] = useState<{
    connectionId: string;
    name: string;
  } | null>(null);
  useEffect(() => {
    if (probed === null) {
      setEngineError("");
      setDetectedEngine(null);
      return;
    }
    let active = true;
    setEngineError("");
    void rpc.computer
      .engine({ connectionId: probed || null })
      .then((engine) => {
        if (active) setDetectedEngine({ connectionId: probed, name: engine.name });
      })
      .catch((error: unknown) => {
        if (active)
          setEngineError(
            error instanceof Error &&
              /^(Docker|Podman) is not running or not reachable at [^\r\n]+\. Start (Docker Desktop|Podman) and try again\.$/.test(
                error.message,
              )
              ? error.message
              : t`Computer engine is unavailable.`,
          );
      });
    return () => {
      active = false;
    };
  }, [probed, engineRefresh]);
  const engine =
    probed !== null && detectedEngine?.connectionId === probed
      ? detectedEngine.name
      : (connection?.settings.engine ??
        (choosingDefault && deploymentDefault ? deploymentDefault : status.kind));
  const savedConnection = connections.find((entry) => entry.id === savedConnectionId);
  const currentKind = computerExecutionKind({
    kind: status.kind,
    connectionId: status.connectionId,
    connectionSettings: savedConnection?.settings,
  });
  const hostComputer = currentKind === "desktop";

  const engineLabel = (kind: string) =>
    kind !== "desktop"
      ? (ENGINE_LABELS[kind] ?? kind)
      : status.hostLabel === "This Mac"
        ? t`This Mac`
        : t`This computer`;
  // The deployment's engine is offered when the computer runs elsewhere and it is not the host.
  const defaultLabel = deploymentDefault ? ENGINE_LABELS[deploymentDefault] : undefined;
  const offerDeploymentDefault =
    defaultLabel !== undefined &&
    (!!status.connectionId || status.kind !== deploymentDefault) &&
    runtimeSupportsLocation(runtimeKind, { kind: deploymentDefault });
  const defaultOption = t`Deployment default (${defaultLabel})`;
  const supported = ["docker", "podman", "kubernetes", "remote-docker"].includes(engine);
  const selectedKind = choosingHost
    ? "desktop"
    : connection
      ? computerConnectionKind(connection.settings)
      : choosingDefault
        ? deploymentDefault
        : currentKind;
  const selectedFacts = selectedKind ? computerKindFacts(selectedKind) : null;
  const sourceLabel = savedConnection?.name ?? engineLabel(currentKind ?? "");
  const destinationLabel = choosingHost
    ? t`This computer`
    : choosingDefault
      ? defaultOption
      : (connection?.name ?? "");
  const eligibleConnections = connections.filter((entry) =>
    runtimeSupportsLocation(runtimeKind, { kind: computerConnectionKind(entry.settings) }),
  );
  const offerHost =
    !hostComputer && hostConnected && runtimeSupportsLocation(runtimeKind, { kind: "desktop" });
  const selectionSupported =
    runtimeSupportsLocation(runtimeKind, { kind: selectedKind }) &&
    (!choosingHost || hostConnected);
  const showLocationChoices =
    choicesOnly || !hostComputer || runtimeSupportsLocation(runtimeKind, { kind: "docker" });
  const sandbox = recommendedContainer(deploymentDefault ?? "", connections);
  async function save() {
    setPending(true);
    setError("");
    try {
      await rpc.computer.configure({
        botId,
        ...(selectedKind === "desktop" || hostComputer ? {} : { imageProfile: profile }),
        ...(selection === savedConnectionId
          ? {}
          : choosingHost
            ? { destination: "host" as const }
            : {
                connectionId: choosingDefault ? null : selection,
                ...(choosingDefault && selectedFacts?.boundary === "container"
                  ? { destination: "sandbox" as const }
                  : {}),
              }),
        confirmed: true,
      });
      setConfirm(false);
      await onChanged();
    } catch (caught: unknown) {
      setError(
        computerRefusalMessage(
          caught,
          t`Could not change the computer; stop its bots and try again.`,
        ),
      );
    } finally {
      setPending(false);
    }
  }
  const label = engineLabel(currentKind ?? "");
  return (
    <section className="space-y-3 rounded-xl border border-border p-4">
      {!choicesOnly ? (
        <MoveToHost
          botId={botId}
          runtimeKind={runtimeKind}
          location={{ ...status, connectionSettings: savedConnection?.settings }}
          hostAvailable={hostConnected}
          state={status.state}
          onChanged={onChanged}
        />
      ) : null}
      {!choicesOnly ? (
        <>
          <h4>{status.mode === "team" ? t`Team Computer` : name}</h4>
          <p className="text-sm text-muted-foreground">
            <Trans>Engine: {label}</Trans>
          </p>
          <RuntimeSummary
            status={status}
            locationName={hostComputer ? undefined : savedConnection?.name}
            connectionSettings={savedConnection?.settings}
          />
        </>
      ) : null}
      {showLocationChoices ? (
        <ComputerLocationPicker
          value={selectedKind === "desktop" ? "host" : "sandbox"}
          hostAvailable={hostConnected}
          sandboxAvailable={Boolean(sandbox) || selectedFacts?.boundary === "container"}
          runtimeKind={runtimeKind}
          disabled={pending}
          onChange={(location) => {
            if (location === "host") setSelection(hostComputer ? savedConnectionId : HOST_COMPUTER);
            else if (currentKind && computerKindFacts(currentKind)?.boundary === "container")
              setSelection(savedConnectionId);
            else if (sandbox) setSelection(sandbox.connectionId ?? DEPLOYMENT_DEFAULT);
          }}
        />
      ) : null}
      {selection !== savedConnectionId && selectedKind && selectedFacts ? (
        <div className="space-y-2 text-sm">
          <p>
            {selectedFacts.boundary === "container" ? t`Move to a container` : t`Change computer`}
          </p>
          <RuntimeBoundary kind={selectedKind} locationName={connection?.name} />
        </div>
      ) : null}
      {engineError ? (
        <div role="alert" className="text-sm text-destructive">
          <p>{engineError}</p>
          <Button variant="outline" onClick={() => setEngineRefresh((value) => value + 1)}>
            <Trans>Retry</Trans>
          </Button>
        </div>
      ) : null}
      {!status.connectionId &&
      !offerDeploymentDefault &&
      !offerHost &&
      eligibleConnections.length === 0 ? null : (
        <label htmlFor={`connection-${botId}`} className="block space-y-1">
          <span>
            <Trans>Connection</Trans>
          </span>
          <NativeSelect
            id={`connection-${botId}`}
            aria-label={t`Connection`}
            value={selection}
            disabled={pending}
            onChange={(event) => setSelection(event.target.value)}
          >
            <NativeSelectOption value={savedConnectionId}>
              {choicesOnly ? t`Keep current location` : sourceLabel}
            </NativeSelectOption>
            {offerDeploymentDefault ? (
              <NativeSelectOption value={DEPLOYMENT_DEFAULT}>{defaultOption}</NativeSelectOption>
            ) : null}
            {offerHost ? (
              <NativeSelectOption value={HOST_COMPUTER}>{t`This computer`}</NativeSelectOption>
            ) : null}
            {eligibleConnections
              .filter((entry) => entry.id !== savedConnectionId)
              .map((entry) => (
                <NativeSelectOption key={entry.id} value={entry.id}>
                  {entry.name}
                </NativeSelectOption>
              ))}
          </NativeSelect>
        </label>
      )}

      {supported && selectedKind !== "desktop" && selectionSupported ? (
        <>
          <label htmlFor={`profile-${botId}`} className="block space-y-1">
            <span>
              <Trans>Image profile</Trans>
            </span>
            <NativeSelect
              id={`profile-${botId}`}
              aria-label={t`Image profile`}
              value={profile}
              disabled={pending}
              onChange={(event) => setProfile(event.target.value as ComputerProfileId)}
            >
              {Object.keys(COMPUTER_PROFILES).map((id) => (
                <NativeSelectOption key={id} value={id}>
                  {id === "base"
                    ? t`Standard`
                    : t`Developer (git, GitHub and GitLab CLIs, node, jq)`}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          {status.capabilities?.graphical === false &&
          status.capabilities.interactiveTerminal === false ? (
            <p>
              <Trans>Screen and terminal: Not available on this computer</Trans>
            </p>
          ) : null}
          <p className="text-sm text-muted-foreground">
            <Trans>Developer is a larger download and uses more disk space.</Trans>
          </p>
        </>
      ) : null}
      <Button
        disabled={
          pending ||
          !selectedFacts ||
          !selectionSupported ||
          status.state === "booting" ||
          (profile === (status.imageProfile ?? "base") && selection === savedConnectionId)
        }
        onClick={() => setConfirm(true)}
      >
        <Trans>Apply</Trans>
      </Button>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
      <AlertDialog
        open={confirm}
        onOpenChange={(open) => {
          if (!pending) setConfirm(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Change computer</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              {selection !== savedConnectionId
                ? // biome-ignore format: one catalog sentence
                  t`This moves the computer from ${sourceLabel} to ${destinationLabel} and replaces its files. Continue?`
                : t`This replaces the computer's files. Continue?`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <Trans>Continue</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
