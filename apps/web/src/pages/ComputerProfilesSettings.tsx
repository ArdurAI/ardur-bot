import type {
  ComputerConnectionSettings,
  ComputerProfileId,
  ComputerStatus,
} from "@ardurbot/contracts";
import { COMPUTER_PROFILES } from "@ardurbot/contracts";
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
export function ComputerProfilesSettings() {
  const { t } = useLingui();
  const [computers, setComputers] = useState<
    { botId: string; name: string; status: ComputerStatus }[]
  >([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [error, setError] = useState("");
  async function refresh() {
    const [computers, connections] = await Promise.all([
      rpc.computer.list(),
      rpc.computer.connections(),
    ]);
    setComputers(computers);
    setConnections(connections);
  }
  useEffect(() => {
    const reload = () =>
      void refresh().catch(() => setError(t`Computers are unavailable; reconnect and try again.`));
    reload();
    window.addEventListener("fleet:changed", reload);
    return () => window.removeEventListener("fleet:changed", reload);
  }, [t]);
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
  onChanged,
}: {
  botId: string;
  name: string;
  status: ComputerStatus;
  connections: Connection[];
  onChanged: () => Promise<void>;
}) {
  const { t } = useLingui();
  const [profile, setProfile] = useState<ComputerProfileId>(status.imageProfile ?? "base");
  const [connectionId, setConnectionId] = useState(status.connectionId ?? "");
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const connection = connections.find((entry) => entry.id === connectionId);
  const [detectedEngine, setDetectedEngine] = useState<{
    connectionId: string;
    name: string;
  } | null>(null);
  useEffect(() => {
    let active = true;
    void rpc.computer
      .engine({ connectionId: connectionId || null })
      .then((engine) => {
        if (active) setDetectedEngine({ connectionId, name: engine.name });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [connectionId]);
  const engine =
    detectedEngine?.connectionId === connectionId
      ? detectedEngine.name
      : (connection?.settings.engine ?? status.kind);
  const supported = ["docker", "podman", "kubernetes", "remote-docker"].includes(engine);
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
    } catch {
      setError(t`Could not change the computer; stop its bots and try again.`);
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="space-y-3 rounded-xl border border-border p-4">
      <h4>{status.mode === "team" ? t`Team Computer` : name}</h4>
      <p className="text-sm text-muted-foreground">
        <Trans>
          Engine:{" "}
          {engine === "podman"
            ? "Podman"
            : engine === "kubernetes"
              ? "Kubernetes"
              : engine === "docker"
                ? "Docker"
                : engine}
        </Trans>
      </p>
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
          <NativeSelectOption value="">
            <Trans>Deployment default</Trans>
          </NativeSelectOption>
          {connections.map((entry) => (
            <NativeSelectOption key={entry.id} value={entry.id}>
              {entry.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </label>
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
          <p className="text-sm text-muted-foreground">
            <Trans>Developer is a larger download and uses more disk space.</Trans>
          </p>
        </>
      ) : null}
      <Button
        disabled={
          pending ||
          status.state === "booting" ||
          (profile === (status.imageProfile ?? "base") &&
            connectionId === (status.connectionId ?? ""))
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
