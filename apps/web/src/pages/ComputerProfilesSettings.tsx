import type {
  ComputerConnectionSettings,
  ComputerProfileId,
  ComputerStatus,
  Me,
} from "@ardurbot/contracts";
import {
  COMPUTER_PROFILES,
  hostComputerLabel,
  moveOntoThisMacUnavailableMessage,
} from "@ardurbot/contracts";
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

function hostPlatform() {
  if (typeof window !== "undefined" && window.ardurbotDesktop?.platform)
    return window.ardurbotDesktop.platform;
  return typeof navigator !== "undefined" ? navigator.platform : "";
}

export type DeploymentDefault = "docker" | "this-mac" | "other";

export function deploymentDefaultEngine(
  me: Pick<Me, "computerHost" | "sandboxProvider">,
): DeploymentDefault {
  if (me.sandboxProvider === "desktop" || me.computerHost === "this-mac") return "this-mac";
  if (me.sandboxProvider === "docker") return "docker";
  return "other";
}

function engineLabel(engine: string) {
  if (engine === "desktop" || engine === "host") return hostComputerLabel(hostPlatform());
  if (engine === "podman") return "Podman";
  if (engine === "kubernetes") return "Kubernetes";
  if (engine === "docker" || engine === "remote-docker") return "Docker";
  if (engine === "e2b") return "E2B";
  if (engine === "daytona") return "Daytona";
  if (engine === "box") return "Box";
  return engine;
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
  const savedEngine = engineLabel(status.kind);
  const offerDeploymentDefault = !connectionless && deploymentDefault === "docker";
  const supported = ["docker", "podman", "kubernetes", "remote-docker", "desktop"].includes(engine);
  async function save() {
    setPending(true);
    setError("");
    try {
      await rpc.computer.configure({
        botId,
        imageProfile: profile,
        connectionId: connectionId || null,
        confirmed: true,
      });
      setConfirm(false);
      await onChanged();
    } catch (caught: unknown) {
      const message = caught instanceof Error ? caught.message : "";
      setError(
        message === moveOntoThisMacUnavailableMessage
          ? // biome-ignore format: one catalog sentence
            t`Moving this computer onto This Mac is not available yet. Choose a saved connection or keep the current engine.`
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
      <label htmlFor={`connection-${botId}`} className="block space-y-1">
        <span>
          <Trans>Connection</Trans>
        </span>
        <NativeSelect
          id={`connection-${botId}`}
          aria-label={t`Connection`}
          value={connectionId}
          disabled={pending || (connectionless && connections.length === 0)}
          onChange={(event) => setConnectionId(event.target.value)}
        >
          {connectionless ? (
            <NativeSelectOption value="">{savedEngine}</NativeSelectOption>
          ) : offerDeploymentDefault ? (
            <NativeSelectOption value="">
              <Trans>Deployment default (Docker)</Trans>
            </NativeSelectOption>
          ) : (
            <NativeSelectOption value={savedConnectionId}>{savedEngine}</NativeSelectOption>
          )}
          {connections
            .filter(
              (entry) => connectionless || offerDeploymentDefault || entry.id !== savedConnectionId,
            )
            .map((entry) => (
              <NativeSelectOption key={entry.id} value={entry.id}>
                {entry.name}
              </NativeSelectOption>
            ))}
        </NativeSelect>
      </label>
      {connectionless && connections.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {/* biome-ignore format: one catalog sentence */}
          <Trans>Add a connection under Settings, Connections, to move this computer to another machine.</Trans>
        </p>
      ) : null}
      {supported ? (
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
          {engine === "desktop" ? null : (
            <p className="text-sm text-muted-foreground">
              <Trans>Developer is a larger download and uses more disk space.</Trans>
            </p>
          )}
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
              <Trans>This replaces the computer's files. Continue?</Trans>
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
