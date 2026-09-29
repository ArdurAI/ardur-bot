import type { FleetTarget, PlacementSettings } from "@ardurbot/contracts";
import {
  ComputerConnectionSettingsSchema,
  errorDataCode,
  FLEET_ACTIVE_RUN_CONFLICT_CODE,
  FLEET_PINNED_BOTS_CONFLICT_CODE,
} from "@ardurbot/contracts";
import type { FleetReachabilityReason } from "@ardurbot/contracts/fleet";
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  NativeSelect,
  NativeSelectOption,
  Textarea,
} from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { FeatureDocsLink } from "../../components/FeatureDocsLink";
import { rpc } from "../../lib/rpc";
import { useTargetName } from "./target-name";

type Fleet = Awaited<ReturnType<typeof rpc.fleet.list>>;
type ConnectionDetails = Awaited<ReturnType<typeof rpc.fleet.details>>;

export function discoveredFormKind(
  target?: FleetTarget,
): "docker" | "podman" | "kubernetes" | "ssh" {
  if (target?.kind === "kubernetes") return "kubernetes";
  if (target?.kind === "ssh" || target?.kind === "tailscale" || !target) return "ssh";
  if (
    target.kind === "podman" &&
    /(?:^|[/.:-])podman(?:[/.:-]|$)/i.test(`${target.endpoint ?? ""} ${target.context ?? ""}`)
  )
    return "podman";
  return "docker";
}

function ReachabilityReason({ reason }: { reason: FleetReachabilityReason }) {
  const { t } = useLingui();
  switch (reason) {
    case "engine-not-running":
      return t`Engine not running`;
    case "permission-denied":
      return t`Permission denied on the socket`;
    case "timed-out":
      return t`Timed out`;
    case "socket-missing":
      return t`Socket missing`;
    case "not-reachable":
      return t`Engine not reachable`;
    default:
      return "";
  }
}

export function FleetSettings() {
  const { t } = useLingui();
  const [fleet, setFleet] = useState<Fleet | null>(null);
  const targetName = useTargetName(fleet?.hostLabel);
  const [discovered, setDiscovered] = useState<FleetTarget[]>([]);
  const [adding, setAdding] = useState<{
    target?: FleetTarget;
    details?: ConnectionDetails;
  } | null>(null);
  const [removing, setRemoving] = useState<FleetTarget | null>(null);
  const [removeError, setRemoveError] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refresh = async () => setFleet(await rpc.fleet.list());
  useEffect(() => {
    let active = true;
    const poll = () =>
      void rpc.fleet
        .list()
        .then((value) => {
          if (active) setFleet(value);
        })
        .catch(() => {
          if (active) setError(t`Computers are unavailable; reconnect and try again.`);
        });
    poll();
    void rpc.fleet
      .discover()
      .then((value) => {
        if (active) setDiscovered(value);
      })
      .catch(() => undefined);
    const timer = setInterval(poll, 30000);
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
      setError(t`Could not update the computer. Check the connection and try again.`);
    } finally {
      setBusy(false);
    }
  }
  const targets = [
    ...(fleet?.targets ?? []),
    ...discovered.filter(
      (target) =>
        !fleet?.targets.some(
          (saved) =>
            (target.endpoint && target.endpoint === saved.endpoint) ||
            (target.kind === "kubernetes" && target.context === saved.context) ||
            (target.ssh && target.ssh.host === saved.ssh?.host),
        ),
    ),
  ];
  const pendingName = (id: string) => {
    const target = targets.find((target) => target.id === id);
    return target && targetName(target);
  };
  return (
    <section className="space-y-4" data-testid="fleet-settings">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-medium">
          <Trans>Computers</Trans>
        </h3>
        <Button variant="outline" onClick={() => setAdding({})}>
          <Trans>Add computer</Trans>
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <ul className="divide-y divide-border">
        {targets.map((target) => (
          <li key={target.id} className="space-y-2 py-3" data-fleet-target={target.id}>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-medium">{targetName(target)}</p>
                <p className="text-xs text-muted-foreground">
                  {target.reachability?.status === "running"
                    ? t`Running`
                    : target.reachability?.status === "installed-not-running"
                      ? t`Installed, not running`
                      : target.reachability?.status === "not-reachable"
                        ? t`Not reachable`
                        : target.state === "connected"
                          ? t`Connected`
                          : target.state === "discovered"
                            ? t`Available`
                            : t`Unavailable`}
                  {target.reachability?.reason ? (
                    <>
                      {" "}
                      · <ReachabilityReason reason={target.reachability.reason} />
                    </>
                  ) : null}
                  {target.endpoint && target.kind === "tailscale" ? ` · ${target.endpoint}` : ""}
                </p>
                {target.reachability?.status === "installed-not-running" ? (
                  <p className="text-xs text-muted-foreground">
                    <Trans>Start the engine and press Test.</Trans>
                  </p>
                ) : null}
                {target.reachability?.checkedAt ? (
                  <p className="text-xs text-muted-foreground">
                    <Trans>
                      Checked {new Date(target.reachability.checkedAt).toLocaleString()}
                    </Trans>
                  </p>
                ) : null}
              </div>
              {target.state === "discovered" ? (
                <Button variant="ghost" onClick={() => setAdding({ target })}>
                  {target.kind === "tailscale" ? t`Add as SSH computer` : t`Add`}
                </Button>
              ) : (
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        const tested = await rpc.fleet.test({ connectionId: target.connectionId });
                        setFleet((current) =>
                          current
                            ? {
                                ...current,
                                targets: current.targets.map(
                                  (row) =>
                                    tested.targets.find((result) => result.id === row.id) ?? row,
                                ),
                              }
                            : current,
                        );
                      })
                    }
                  >
                    <Trans>Test</Trans>
                  </Button>
                  {target.connectionId ? (
                    <>
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          void rpc.fleet
                            .details({ connectionId: target.connectionId! })
                            .then((details) => setAdding({ target, details }))
                            .catch(() => setError(t`Could not load this computer. Try again.`))
                        }
                      >
                        <Trans>Edit</Trans>
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          setRemoveError("");
                          setRemoving(target);
                        }}
                      >
                        <Trans>Remove</Trans>
                      </Button>
                    </>
                  ) : null}
                </div>
              )}
            </div>
            <CapacityBar target={target} />
            {target.version ? (
              <p className="text-xs text-muted-foreground">
                {target.version} · {target.os}
              </p>
            ) : null}
            {target.bots.length ? (
              <p className="text-xs text-muted-foreground">
                {target.bots.map((bot) => bot.name).join(", ")}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
      {fleet ? (
        <PlacementControls
          settings={fleet.placement}
          targets={fleet.targets}
          targetName={targetName}
          disabled={busy}
          onSave={(settings) => perform(() => rpc.fleet.placement(settings))}
        />
      ) : null}
      {fleet?.placement.mode !== "manual"
        ? fleet?.bots.map((bot) => (
            <div key={bot.id} className="space-y-2 border-t border-border pt-3">
              <label
                htmlFor={`fleet-auto-${bot.id}`}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <span>
                  {bot.name} · <Trans>Move automatically</Trans>
                </span>
                <Checkbox
                  id={`fleet-auto-${bot.id}`}
                  checked={bot.moveAutomatically}
                  disabled={busy}
                  onCheckedChange={(checked) =>
                    void perform(() => rpc.fleet.bot({ botId: bot.id, moveAutomatically: checked }))
                  }
                />
              </label>
              {bot.pending ? (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span>
                    <Trans>Move to {pendingName(bot.pending.targetId) ?? t`computer`}?</Trans>
                  </span>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void perform(() => rpc.fleet.bot({ botId: bot.id, decision: "accept" }))
                    }
                  >
                    <Trans>Move</Trans>
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void perform(() => rpc.fleet.bot({ botId: bot.id, decision: "decline" }))
                    }
                  >
                    <Trans>Keep here</Trans>
                  </Button>
                </div>
              ) : null}
            </div>
          ))
        : null}
      {adding ? (
        <AddComputer
          key={adding.target?.id ?? "new"}
          target={adding.target}
          details={adding.details}
          onRefresh={refresh}
          onCancel={() => setAdding(null)}
          onSaved={async () => {
            setAdding(null);
            await refresh();
            window.dispatchEvent(new Event("fleet:changed"));
          }}
        />
      ) : null}
      {removing ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !busy) setRemoving(null);
          }}
        >
          <DialogContent aria-label={t`Remove computer`} aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle>
                <Trans>Remove computer</Trans>
              </DialogTitle>
            </DialogHeader>
            <p className="text-sm">
              <Trans>
                Remove {targetName(removing)}? Its saved connection and credentials will be deleted.
                Past run history remains.
              </Trans>
            </p>
            {removing.bots.length ? (
              <p className="text-sm text-muted-foreground">
                <Trans>
                  Bots on this computer: {removing.bots.map((bot) => bot.name).join(", ")}
                </Trans>
              </p>
            ) : null}
            {removeError ? (
              <p role="alert" className="text-sm text-destructive">
                {removeError}
              </p>
            ) : null}
            <div className="flex gap-2">
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void rpc.fleet
                    .remove({ connectionId: removing.connectionId! })
                    .then(async () => {
                      setRemoving(null);
                      await refresh();
                      window.dispatchEvent(new Event("fleet:changed"));
                    })
                    .catch((cause: unknown) => {
                      const data =
                        typeof cause === "object" && cause !== null && "data" in cause
                          ? cause.data
                          : undefined;
                      const botNames =
                        errorDataCode(cause) === FLEET_PINNED_BOTS_CONFLICT_CODE &&
                        typeof data === "object" &&
                        data !== null &&
                        "botNames" in data &&
                        Array.isArray(data.botNames) &&
                        data.botNames.every((name) => typeof name === "string")
                          ? (data.botNames as string[])
                          : null;
                      setRemoveError(
                        botNames
                          ? t`Move bots first: ${botNames.join(", ")}`
                          : t`Could not remove this computer. Try again.`,
                      );
                    })
                    .finally(() => setBusy(false));
                }}
              >
                <Trans>Remove</Trans>
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => setRemoving(null)}>
                <Trans>Cancel</Trans>
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </section>
  );
}

export function CapacityBar({ target }: { target: FleetTarget }) {
  const { t } = useLingui();
  const { memoryFree, memoryTotal, cpuCount, cpuLoad1m, diskFree } = target.capacity;
  if (
    memoryFree === null &&
    target.reachability?.status !== "running" &&
    (target.state !== "connected" || target.kind === "docker" || target.kind === "podman")
  )
    return null;
  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      <p>
        {memoryFree === null
          ? t`Memory not reported`
          : t`${(memoryFree / 1024 ** 3).toFixed(1)} GB free`}
        {cpuCount !== null ? ` · ${cpuCount} CPU` : ""}
        {cpuLoad1m !== null ? ` · ${t`Load`} ${cpuLoad1m.toFixed(1)}` : ""}
        {diskFree !== null ? ` · ${t`Disk`} ${(diskFree / 1024 ** 3).toFixed(1)} GB` : ""}
      </p>
      {memoryFree !== null && memoryTotal !== null && memoryTotal > 0 ? (
        <progress
          className="h-1.5 w-full accent-primary"
          aria-label={t`Free memory`}
          value={Math.min(memoryFree, memoryTotal)}
          max={memoryTotal}
        />
      ) : null}
    </div>
  );
}

function PlacementControls({
  settings,
  targets,
  targetName,
  disabled,
  onSave,
}: {
  settings: PlacementSettings;
  targets: FleetTarget[];
  targetName: (target: FleetTarget) => string;
  disabled: boolean;
  onSave: (value: PlacementSettings) => Promise<void>;
}) {
  const { t } = useLingui();
  const [value, setValue] = useState(settings);
  useEffect(() => setValue(settings), [settings]);
  return (
    <fieldset className="space-y-2 border-t border-border pt-4" disabled={disabled}>
      <legend className="text-sm font-medium">
        <Trans>Placement</Trans>
      </legend>
      <NativeSelect
        aria-label={t`Placement`}
        value={value.mode}
        onChange={(event) => {
          const next = { ...value, mode: event.target.value as PlacementSettings["mode"] };
          setValue(next);
          void onSave(next);
        }}
      >
        <NativeSelectOption value="manual">
          <Trans>Manual</Trans>
        </NativeSelectOption>
        <NativeSelectOption value="free-memory">
          <Trans>Prefer the most free memory</Trans>
        </NativeSelectOption>
        <NativeSelectOption value="threshold">
          <Trans>Move when this Mac has under {value.minimumFreeGb} GB free</Trans>
        </NativeSelectOption>
      </NativeSelect>
      {value.mode === "threshold" ? (
        <div className="flex flex-wrap gap-2">
          <NativeSelect
            aria-label={t`Preferred computer`}
            value={value.preferredTargetId}
            onChange={(event) => {
              const next = { ...value, preferredTargetId: event.target.value };
              setValue(next);
              void onSave(next);
            }}
          >
            {targets
              .filter((target) => target.state === "connected")
              .map((target) => (
                <NativeSelectOption key={target.id} value={target.id}>
                  {targetName(target)}
                </NativeSelectOption>
              ))}
          </NativeSelect>
          <Input
            type="number"
            aria-label={t`Minimum free memory (GB)`}
            min={0.25}
            max={65536}
            step={0.25}
            value={value.minimumFreeGb}
            onChange={(event) => setValue({ ...value, minimumFreeGb: Number(event.target.value) })}
            onBlur={() => {
              if (value.minimumFreeGb >= 0.25) void onSave(value);
            }}
          />
        </div>
      ) : null}
    </fieldset>
  );
}

function AddComputer({
  target,
  details,
  onCancel,
  onSaved,
  onRefresh,
}: {
  target?: FleetTarget;
  details?: ConnectionDetails;
  onCancel: () => void;
  onSaved: () => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const { t } = useLingui();
  const [kind, setKind] = useState(details?.settings.engine ?? discoveredFormKind(target));
  const [name, setName] = useState(details?.name ?? target?.name ?? "");
  const [host, setHost] = useState(details?.settings.ssh?.host ?? target?.ssh?.host ?? "");
  const [user, setUser] = useState(details?.settings.ssh?.user ?? target?.ssh?.user ?? "");
  const [port, setPort] = useState(details?.settings.ssh?.port ?? target?.ssh?.port ?? 22);
  const [authentication, setAuthentication] = useState(
    details?.settings.ssh?.authentication ?? target?.ssh?.authentication ?? "agent",
  );
  const [keyPath, setKeyPath] = useState("");
  const [jumpHost, setJumpHost] = useState(details?.settings.ssh?.jumpHost ?? "");
  const [baseDirectory, setBaseDirectory] = useState(
    details?.settings.ssh?.baseDirectory ?? "~/.ardurbot/computers",
  );
  const [endpoint, setEndpoint] = useState(
    details?.settings.endpoint ?? details?.settings.socket ?? target?.endpoint ?? "",
  );
  const [context, setContext] = useState(details?.settings.context ?? target?.context ?? "");
  const [namespace, setNamespace] = useState(details?.settings.namespace ?? "ardurbot");
  const [kubeconfig, setKubeconfig] = useState("");
  const [kubeconfigPath, setKubeconfigPath] = useState(details?.kubeconfigPath ?? "");
  const [resources, setResources] = useState({
    storageSize: details?.settings.storageSize ?? "10Gi",
    storageClass: details?.settings.storageClass ?? "",
    cpuRequest: details?.settings.cpuRequest ?? "250m",
    cpuLimit: details?.settings.cpuLimit ?? "2",
    memoryRequest: details?.settings.memoryRequest ?? "256Mi",
    memoryLimit: details?.settings.memoryLimit ?? "2Gi",
  });
  const [images, setImages] = useState({
    standardImage: details?.settings.standardImage ?? "",
    developerImage: details?.settings.developerImage ?? "",
    imagePullSecret: details?.settings.imagePullSecret ?? "",
  });
  const [tls, setTls] = useState({ ca: "", cert: "", key: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [probeReason, setProbeReason] = useState<FleetReachabilityReason | null>(null);
  const [revision, setRevision] = useState(details?.revision);
  const [confirmActive, setConfirmActive] = useState(false);
  async function save(event?: FormEvent) {
    event?.preventDefault();
    setBusy(true);
    setError("");
    try {
      const settings = ComputerConnectionSettingsSchema.parse({
        ...resources,
        storageClass: resources.storageClass || undefined,
        ...(details ? { namespace: details.settings.namespace } : {}),
        ...(details?.settings.engine === kind ? details.settings : {}),
        engine: kind,
        ...(kind === "ssh"
          ? {
              ssh: {
                host,
                user,
                port,
                authentication,
                baseDirectory,
                ...(jumpHost ? { jumpHost } : {}),
              },
            }
          : kind === "kubernetes"
            ? {
                context,
                namespace,
                ...resources,
                storageClass: resources.storageClass || undefined,
              }
            : {
                ...resources,
                storageClass: resources.storageClass || undefined,
                endpoint: undefined,
                socket: undefined,
                dockerContext: undefined,
                ...(details?.settings.socket && endpoint === details.settings.socket
                  ? { socket: endpoint }
                  : { endpoint }),
                ...((details?.settings.dockerContext ?? target?.context) &&
                endpoint === (details?.settings.endpoint ?? target?.endpoint)
                  ? { dockerContext: details?.settings.dockerContext ?? target?.context }
                  : {}),
              }),
        ...(kind === "ssh"
          ? {}
          : {
              standardImage: images.standardImage.trim() || undefined,
              developerImage: images.developerImage.trim() || undefined,
              imagePullSecret:
                (kind === "kubernetes" && images.imagePullSecret.trim()) || undefined,
            }),
      });
      const connection = {
        name,
        settings,
        ...(kind === "ssh" && authentication === "private-key" && keyPath
          ? { privateKeyPath: keyPath }
          : {}),
        ...(kind === "kubernetes" && kubeconfig ? { kubeconfig } : {}),
        ...(kind === "kubernetes" && kubeconfigPath && kubeconfigPath !== details?.kubeconfigPath
          ? { kubeconfigPath }
          : {}),
        ...(endpoint.startsWith("tcp://") && Object.values(tls).some(Boolean)
          ? { tlsPaths: tls }
          : {}),
      };
      if (details) {
        const changed =
          JSON.stringify({ ...settings, hostSecretId: undefined }) !==
            JSON.stringify({ ...details.settings, hostSecretId: undefined }) ||
          Boolean(
            keyPath ||
              kubeconfig ||
              (kubeconfigPath && kubeconfigPath !== details.kubeconfigPath) ||
              Object.values(tls).some(Boolean),
          );
        if (details.activeRuns && changed && !confirmActive) {
          setConfirmActive(true);
          return;
        }
        const result = await rpc.fleet.update({
          connectionId: details.id,
          connection,
          revision: revision ?? details.revision,
          confirmActive,
        });
        setRevision(result.revision);
        if (!result.ok) {
          setProbeReason(result.reason);
          await onRefresh();
          return;
        }
      } else await rpc.computer.connect(connection);
      await onSaved();
    } catch (cause) {
      if (details && errorDataCode(cause) === FLEET_ACTIVE_RUN_CONFLICT_CODE) {
        setConfirmActive(true);
        return;
      }
      setError(
        details
          ? t`Could not update the computer. Check its settings and try again.`
          : t`Could not add the computer. Check its settings and try again.`,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <DialogContent
        aria-label={details ? t`Edit computer` : t`Add computer`}
        aria-labelledby="add-computer-dialog-title"
        aria-describedby={undefined}
        showCloseButton={!busy}
        className="max-h-[85vh] overflow-y-auto sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle id="add-computer-dialog-title">
            {details ? <Trans>Edit computer</Trans> : <Trans>Add computer</Trans>}
          </DialogTitle>
          {!details ? (
            <FeatureDocsLink featureId="computers" title={t`Computers`} step="open-add-computer" />
          ) : null}
        </DialogHeader>
        <form onSubmit={(event) => void save(event)} className="space-y-3">
          <NativeSelect
            aria-label={t`Connection type`}
            value={kind}
            onChange={(event) => setKind(event.target.value as typeof kind)}
          >
            <NativeSelectOption value="ssh">
              <Trans>SSH machine</Trans>
            </NativeSelectOption>
            <NativeSelectOption value="docker">Docker</NativeSelectOption>
            <NativeSelectOption value="podman">Podman</NativeSelectOption>
            <NativeSelectOption value="kubernetes">
              <Trans>Kubernetes context</Trans>
            </NativeSelectOption>
          </NativeSelect>
          <Input
            aria-label={t`Name`}
            placeholder={t`Name`}
            required
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          {kind === "ssh" ? (
            <>
              <Input
                aria-label={t`Host`}
                placeholder={t`Host`}
                required
                value={host}
                onChange={(event) => setHost(event.target.value)}
              />
              <Input
                aria-label={t`User`}
                placeholder={t`User`}
                required
                value={user}
                onChange={(event) => setUser(event.target.value)}
              />
              <NativeSelect
                aria-label={t`Authentication`}
                value={authentication}
                onChange={(event) => setAuthentication(event.target.value as typeof authentication)}
              >
                <NativeSelectOption value="agent">
                  <Trans>SSH agent</Trans>
                </NativeSelectOption>
                <NativeSelectOption value="private-key">
                  <Trans>Private key</Trans>
                </NativeSelectOption>
                <NativeSelectOption value="tailscale">Tailscale SSH</NativeSelectOption>
              </NativeSelect>
              {authentication === "private-key" ? (
                <Input
                  aria-label={t`Private key path on this computer`}
                  placeholder={t`Private key path on this computer`}
                  required={!details?.hasCredential}
                  value={keyPath}
                  onChange={(event) => setKeyPath(event.target.value)}
                />
              ) : null}
              <details>
                <summary className="text-sm text-muted-foreground">
                  <Trans>Advanced</Trans>
                </summary>
                <div className="space-y-2 pt-2">
                  <Input
                    type="number"
                    aria-label={t`Port`}
                    min={1}
                    max={65535}
                    value={port}
                    onChange={(event) => setPort(Number(event.target.value))}
                  />
                  <Input
                    aria-label={t`Jump host`}
                    placeholder={t`Jump host`}
                    value={jumpHost}
                    onChange={(event) => setJumpHost(event.target.value)}
                  />
                  <Input
                    aria-label={t`Remote base directory`}
                    value={baseDirectory}
                    onChange={(event) => setBaseDirectory(event.target.value)}
                  />
                </div>
              </details>
            </>
          ) : kind === "kubernetes" ? (
            <>
              <Input
                aria-label={t`Context`}
                placeholder={t`Context`}
                required
                value={context}
                onChange={(event) => setContext(event.target.value)}
              />
              <Input
                aria-label={t`Namespace`}
                placeholder={t`Namespace`}
                required
                value={namespace}
                onChange={(event) => setNamespace(event.target.value)}
              />
              <details>
                <summary className="text-sm text-muted-foreground">
                  <Trans>Kubeconfig</Trans>
                </summary>
                <Input
                  aria-label={t`Kubeconfig path`}
                  placeholder={t`Kubeconfig path`}
                  value={kubeconfigPath}
                  disabled={!!kubeconfig}
                  onChange={(event) => setKubeconfigPath(event.target.value)}
                />
                <Textarea
                  disabled={!!kubeconfigPath}
                  aria-label={t`Kubeconfig`}
                  value={kubeconfig}
                  onChange={(event) => setKubeconfig(event.target.value)}
                />
              </details>
              <details>
                <summary className="text-sm text-muted-foreground">
                  <Trans>Resources</Trans>
                </summary>
                <div className="space-y-2 pt-2">
                  {(
                    [
                      ["storageSize", t`Storage size`],
                      ["storageClass", t`Storage class`],
                      ["cpuRequest", t`CPU request`],
                      ["cpuLimit", t`CPU limit`],
                      ["memoryRequest", t`Memory request`],
                      ["memoryLimit", t`Memory limit`],
                    ] as const
                  ).map(([key, label]) => (
                    <Input
                      key={key}
                      aria-label={label}
                      placeholder={label}
                      value={resources[key]}
                      onChange={(event) =>
                        setResources({ ...resources, [key]: event.target.value })
                      }
                    />
                  ))}
                </div>
              </details>
            </>
          ) : (
            <>
              <Input
                aria-label={t`Engine endpoint`}
                placeholder={t`Engine endpoint`}
                required
                value={endpoint}
                onChange={(event) => setEndpoint(event.target.value)}
              />
              {endpoint.startsWith("tcp://")
                ? (["ca", "cert", "key"] as const).map((key) => (
                    <Input
                      key={key}
                      aria-label={
                        key === "ca"
                          ? t`CA certificate path`
                          : key === "cert"
                            ? t`Client certificate path`
                            : t`Client key path`
                      }
                      placeholder={
                        key === "ca"
                          ? t`CA certificate path`
                          : key === "cert"
                            ? t`Client certificate path`
                            : t`Client key path`
                      }
                      required={!details?.hasCredential}
                      value={tls[key]}
                      onChange={(event) => setTls({ ...tls, [key]: event.target.value })}
                    />
                  ))
                : null}
            </>
          )}
          {kind !== "ssh" ? (
            <details>
              <summary className="text-sm text-muted-foreground">
                <Trans>Advanced</Trans>
              </summary>
              <div className="space-y-2 pt-2">
                {(
                  [
                    ["standardImage", t`Standard image`],
                    ["developerImage", t`Developer image`],
                    ...(kind === "kubernetes"
                      ? ([["imagePullSecret", t`Image pull secret`]] as const)
                      : []),
                  ] as const
                ).map(([key, label]) => (
                  <Input
                    key={key}
                    aria-label={label}
                    placeholder={label}
                    value={images[key]}
                    onChange={(event) => setImages({ ...images, [key]: event.target.value })}
                  />
                ))}
              </div>
            </details>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {confirmActive ? (
            <p role="alert" className="text-sm text-destructive">
              <Trans>
                Runs are active on this computer. Saving this connection change may interrupt them.
                Save anyway?
              </Trans>
            </p>
          ) : null}
          {probeReason ? (
            <p role="status" className="text-sm text-destructive">
              <Trans>Connection saved, but the test failed:</Trans>{" "}
              <ReachabilityReason reason={probeReason} />
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>
              {confirmActive ? (
                <Trans>Save anyway</Trans>
              ) : details ? (
                <Trans>Save</Trans>
              ) : (
                <Trans>Add</Trans>
              )}
            </Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
              <Trans>Cancel</Trans>
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
