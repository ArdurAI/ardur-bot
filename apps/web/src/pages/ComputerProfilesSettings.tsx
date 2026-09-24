import type {
  ComputerConnectionSettings,
  ComputerProfileId,
  ComputerStatus,
} from "@ardurbot/contracts";
import { COMPUTER_PROFILES, ComputerConnectionSettingsSchema } from "@ardurbot/contracts";
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
  Input,
  NativeSelect,
  NativeSelectOption,
  Textarea,
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
    void refresh().catch(() => setError(t`Computers are unavailable; reconnect and try again.`));
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
          onChanged={refresh}
        />
      ))}
      <ConnectionForm onSaved={refresh} />
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
  const [engineError, setEngineError] = useState("");
  const [engineRefresh, setEngineRefresh] = useState(0);
  const [detectedEngine, setDetectedEngine] = useState<{
    connectionId: string;
    name: string;
  } | null>(null);
  useEffect(() => {
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
  }, [connectionId, engineRefresh]);
  const engine =
    detectedEngine?.connectionId === connectionId
      ? detectedEngine.name
      : (connection?.settings.engine ?? status.kind);
  const supported = ["docker", "podman", "kubernetes"].includes(engine);
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
          <p className="text-sm text-muted-foreground">
            <Trans>Developer is a larger download and uses more disk space.</Trans>
          </p>
          {status.capabilities?.graphical === false ? (
            <p>
              <Trans>Screen and terminal: Not available on this computer</Trans>
            </p>
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
        </>
      ) : null}
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

function ConnectionForm({ onSaved }: { onSaved: () => Promise<void> }) {
  const { t } = useLingui();
  const [engine, setEngine] = useState<ComputerConnectionSettings["engine"]>("docker");
  const [name, setName] = useState("");
  const [socket, setSocket] = useState("");
  const [kubeconfig, setKubeconfig] = useState("");
  const [kubeconfigPath, setKubeconfigPath] = useState("");
  const [contexts, setContexts] = useState<{ name: string; local: boolean }[]>([]);
  const [context, setContext] = useState("");
  const [namespace, setNamespace] = useState("ardurbot");
  const [storageSize, setStorageSize] = useState("10Gi");
  const [storageClass, setStorageClass] = useState("");
  const [cpuRequest, setCpuRequest] = useState("250m");
  const [cpuLimit, setCpuLimit] = useState("2");
  const [memoryRequest, setMemoryRequest] = useState("256Mi");
  const [memoryLimit, setMemoryLimit] = useState("2Gi");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function act(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch {
      setError(t`Could not save the connection; check its settings and try again.`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="rounded-xl border border-border p-4">
      <summary>
        <Trans>Add computer connection</Trans>
      </summary>
      <div className="mt-3 space-y-3">
        <Input
          aria-label={t`Connection name`}
          placeholder={t`Connection name`}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <NativeSelect
          aria-label={t`Engine`}
          value={engine}
          onChange={(event) =>
            setEngine(event.target.value as ComputerConnectionSettings["engine"])
          }
        >
          <NativeSelectOption value="docker">Docker</NativeSelectOption>
          <NativeSelectOption value="podman">Podman</NativeSelectOption>
          <NativeSelectOption value="kubernetes">Kubernetes / kind</NativeSelectOption>
        </NativeSelect>
        {engine !== "kubernetes" ? (
          <Input
            aria-label={t`Engine socket`}
            placeholder="unix:///path/to/engine.sock"
            value={socket}
            onChange={(event) => setSocket(event.target.value)}
          />
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              <Trans>Create a kind cluster: kind create cluster --name ardurbot</Trans>
            </p>
            <Input
              aria-label={t`Kubeconfig path`}
              placeholder={t`Kubeconfig path on the server`}
              autoComplete="off"
              value={kubeconfigPath}
              onChange={(event) => {
                setKubeconfigPath(event.target.value);
                setContexts([]);
                setContext("");
              }}
            />
            <Textarea
              aria-label={t`Kubeconfig contents`}
              placeholder={t`Or paste kubeconfig contents`}
              autoComplete="off"
              value={kubeconfig}
              onChange={(event) => {
                setKubeconfig(event.target.value);
                setContexts([]);
                setContext("");
              }}
            />
            <Button
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  setContexts(
                    await rpc.computer.contexts({
                      kubeconfig: kubeconfig || undefined,
                      kubeconfigPath: kubeconfigPath || undefined,
                    }),
                  );
                })
              }
            >
              <Trans>List contexts</Trans>
            </Button>
            <NativeSelect
              aria-label={t`Kubernetes context`}
              value={context}
              onChange={(event) => setContext(event.target.value)}
            >
              <NativeSelectOption value="">
                <Trans>Choose context</Trans>
              </NativeSelectOption>
              {contexts.map((entry) => (
                <NativeSelectOption value={entry.name} key={entry.name}>
                  {entry.name}
                  {entry.local ? " (kind)" : ""}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <Input
              aria-label={t`Namespace`}
              value={namespace}
              onChange={(event) => setNamespace(event.target.value)}
            />
            <Input
              aria-label={t`Home storage size`}
              value={storageSize}
              onChange={(event) => setStorageSize(event.target.value)}
            />
            <details>
              <summary>
                <Trans>Resources</Trans>
              </summary>
              <div className="mt-2 space-y-2">
                <Input
                  aria-label={t`Storage class`}
                  placeholder={t`Storage class`}
                  value={storageClass}
                  onChange={(event) => setStorageClass(event.target.value)}
                />
                <Input
                  aria-label={t`CPU request`}
                  value={cpuRequest}
                  onChange={(event) => setCpuRequest(event.target.value)}
                />
                <Input
                  aria-label={t`CPU limit`}
                  value={cpuLimit}
                  onChange={(event) => setCpuLimit(event.target.value)}
                />
                <Input
                  aria-label={t`Memory request`}
                  value={memoryRequest}
                  onChange={(event) => setMemoryRequest(event.target.value)}
                />
                <Input
                  aria-label={t`Memory limit`}
                  value={memoryLimit}
                  onChange={(event) => setMemoryLimit(event.target.value)}
                />
              </div>
            </details>
          </>
        )}
        <Button
          disabled={busy || !name.trim() || (engine === "kubernetes" && !context)}
          onClick={() =>
            void act(async () => {
              const settings = ComputerConnectionSettingsSchema.parse({
                engine,
                socket: socket || undefined,
                context: context || undefined,
                namespace,
                storageSize,
                storageClass: storageClass || undefined,
                cpuRequest,
                cpuLimit,
                memoryRequest,
                memoryLimit,
              });
              await rpc.computer.connect({
                name,
                settings,
                ...(engine === "kubernetes"
                  ? {
                      kubeconfig: kubeconfig || undefined,
                      kubeconfigPath: kubeconfigPath || undefined,
                    }
                  : {}),
              });
              setKubeconfig("");
              setKubeconfigPath("");
              setContexts([]);
              setContext("");
              setName("");
              await onSaved();
            })
          }
        >
          <Trans>Save connection</Trans>
        </Button>
        {error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </details>
  );
}
