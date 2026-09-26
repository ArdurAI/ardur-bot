import type {
  ComputerConnectionSettings,
  ComputerProfileId,
  ComputerStatus,
  Me,
} from "@ardurbot/contracts";
import { COMPUTER_PROFILES, HOST_MOVE_UNAVAILABLE_MESSAGE } from "@ardurbot/contracts";
import { ENGINE_LABELS } from "@ardurbot/contracts/fleet";
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

type Connection = { id: string; name: string; settings: ComputerConnectionSettings };

export type DeploymentDefault = "docker" | "this-mac" | "other";

export function deploymentDefaultEngine(
  me: Pick<Me, "computerHost" | "sandboxProvider">,
): DeploymentDefault {
  if (me.sandboxProvider === "desktop" || me.computerHost === "this-mac") return "this-mac";
  if (me.sandboxProvider === "docker") return "docker";
  return "other";
}

export function ComputerProfilesSettings() {
  const { t } = useLingui();
  const [computers, setComputers] = useState<
    { botId: string; name: string; status: ComputerStatus }[]
  >([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [deploymentDefault, setDeploymentDefault] = useState<DeploymentDefault>("docker");
  const [error, setError] = useState("");
  async function refresh() {
    const [computers, connections, me] = await Promise.all([
      rpc.computer.list(),
      rpc.computer.connections(),
      rpc.me(),
    ]);
    setComputers(computers);
    setConnections(connections);
    setDeploymentDefault(deploymentDefaultEngine(me));
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
}: {
  botId: string;
  name: string;
  status: ComputerStatus;
  connections: Connection[];
  deploymentDefault?: DeploymentDefault;
  onChanged: () => Promise<void>;
}) {
  const { t } = useLingui();
  const connectionless = !status.connectionId;
  const savedConnectionId = status.connectionId ?? "";
  const [profile, setProfile] = useState<ComputerProfileId>(status.imageProfile ?? "base");
  const [connectionId, setConnectionId] = useState(savedConnectionId);
  useEffect(() => {
    setConnectionId(status.connectionId ?? "");
  }, [status.connectionId, status.kind]);
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const connection = connections.find((entry) => entry.id === connectionId);
  const [engineError, setEngineError] = useState("");
  const [engineRefresh, setEngineRefresh] = useState(0);
  const [detectedEngine, setDetectedEngine] = useState<{
    connectionId: string;
    name: string;
  } | null>(null);
  useEffect(() => {
    if (connectionless && !connectionId) {
      setEngineError("");
      setDetectedEngine(null);
      return;
    }
    let active = true;
    setEngineError("");
    void rpc.computer
      .engine({ connectionId: connectionId || null })
      .then((engine) => {
        if (active) setDetectedEngine({ connectionId, name: engine.name });
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
  }, [connectionless, connectionId, engineRefresh]);
  const staying = connectionless && !connectionId;
  const engine = staying
    ? status.kind
    : detectedEngine?.connectionId === connectionId
      ? detectedEngine.name
      : (connection?.settings.engine ?? status.kind);
  const hostComputer = status.kind === "desktop";
  const engineLabel = (kind: string) =>
    kind !== "desktop"
      ? (ENGINE_LABELS[kind] ?? kind)
      : status.hostLabel === "This Mac"
        ? t`This Mac`
        : t`This computer`;
  const offerDeploymentDefault = !connectionless && deploymentDefault === "docker";
  const supported = ["docker", "podman", "kubernetes", "remote-docker"].includes(engine);
  const savedConnection = connections.find((entry) => entry.id === savedConnectionId);
  const selectedConnection = connections.find((entry) => entry.id === connectionId);
  const sourceLabel = savedConnection?.name ?? t`this engine`;
  const destinationLabel = connectionId
    ? (selectedConnection?.name ?? t`this engine`)
    : t`Deployment default (Docker)`;
  async function save() {
    setPending(true);
    setError("");
    try {
      await rpc.computer.configure({
        botId,
        ...(hostComputer ? {} : { imageProfile: profile }),
        connectionId: connectionId || null,
        confirmed: true,
      });
      setConfirm(false);
      await onChanged();
    } catch (caught: unknown) {
      setError(
        caught instanceof Error && caught.message === HOST_MOVE_UNAVAILABLE_MESSAGE
          ? // biome-ignore format: one catalog sentence
            t`Moving a computer onto the machine running Ardur Bot is not available yet. Choose a saved connection or keep the current engine.`
          : t`Could not change the computer; stop its bots and try again.`,
      );
    } finally {
      setPending(false);
    }
  }
  const label = engineLabel(engine);
  return (
    <section className="space-y-3 rounded-xl border border-border p-4">
      <h4>{status.mode === "team" ? t`Team Computer` : name}</h4>
      <p className="text-sm text-muted-foreground">
        <Trans>Engine: {label}</Trans>
      </p>
      {engineError ? (
        <div role="alert" className="text-sm text-destructive">
          <p>{engineError}</p>
          <Button variant="outline" onClick={() => setEngineRefresh((value) => value + 1)}>
            <Trans>Retry</Trans>
          </Button>
        </div>
      ) : null}
      {connectionless && connections.length === 0 ? null : (
        <label htmlFor={`connection-${botId}`} className="block space-y-1">
          <span>
            <Trans>Connection</Trans>
          </span>
          <NativeSelect
            id={`connection-${botId}`}
            aria-label={t`Connection`}
            value={connectionId}
            disabled={pending}
            onChange={(event) => setConnectionId(event.target.value)}
          >
            {connectionless ? (
              <NativeSelectOption value="">{engineLabel(status.kind)}</NativeSelectOption>
            ) : offerDeploymentDefault ? (
              <NativeSelectOption value="">
                <Trans>Deployment default (Docker)</Trans>
              </NativeSelectOption>
            ) : (
              <NativeSelectOption value={savedConnectionId}>
                {savedConnection?.name ?? t`this engine`}
              </NativeSelectOption>
            )}
            {connections
              .filter(
                (entry) =>
                  connectionless || offerDeploymentDefault || entry.id !== savedConnectionId,
              )
              .map((entry) => (
                <NativeSelectOption key={entry.id} value={entry.id}>
                  {entry.name}
                </NativeSelectOption>
              ))}
          </NativeSelect>
        </label>
      )}
      {supported && !hostComputer ? (
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
          status.state === "booting" ||
          (profile === (status.imageProfile ?? "base") && connectionId === savedConnectionId)
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
              {connectionId !== savedConnectionId
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
