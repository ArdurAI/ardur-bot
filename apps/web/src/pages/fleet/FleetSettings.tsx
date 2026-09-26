import type {
  CapacitySnapshot,
  FleetTarget,
  HostLabel,
  PlacementSettings,
} from "@ardurbot/contracts";
import { ComputerConnectionSettingsSchema } from "@ardurbot/contracts";
import {
  Button,
  Checkbox,
  Input,
  NativeSelect,
  NativeSelectOption,
  Textarea,
} from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { rpc } from "../../lib/rpc";

type Fleet = Awaited<ReturnType<typeof rpc.fleet.list>>;

/** Built-in rows are named here, in the reader's language. */
function useTargetName(hostLabel: HostLabel | undefined) {
  const { t } = useLingui();
  const mac = hostLabel === "This Mac";
  return (target: Pick<FleetTarget, "name" | "builtin">) =>
    target.builtin === "host"
      ? mac
        ? t`This Mac`
        : t`This computer`
      : target.builtin === "local-docker"
        ? mac
          ? t`Docker on this Mac`
          : t`Docker on this computer`
        : target.builtin === "default"
          ? t`Default computer`
          : target.name;
}

export function FleetSettings() {
  const { t } = useLingui();
  const [fleet, setFleet] = useState<Fleet | null>(null);
  const targetName = useTargetName(fleet?.hostLabel);
  const [discovered, setDiscovered] = useState<FleetTarget[]>([]);
  const [adding, setAdding] = useState<{ target?: FleetTarget } | null>(null);
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
                  {target.state === "connected"
                    ? t`Connected`
                    : target.state === "discovered"
                      ? t`Available`
                      : t`Unavailable`}
                  {target.endpoint && target.kind === "tailscale" ? ` · ${target.endpoint}` : ""}
                </p>
              </div>
              {target.state === "discovered" ? (
                <Button variant="ghost" onClick={() => setAdding({ target })}>
                  {target.kind === "tailscale" ? t`Add as SSH computer` : t`Add`}
                </Button>
              ) : (
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
                                (row) => tested.find((result) => result.id === row.id) ?? row,
                              ),
                            }
                          : current,
                      );
                    })
                  }
                >
                  <Trans>Test</Trans>
                </Button>
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
          onCancel={() => setAdding(null)}
          onSaved={async () => {
            setAdding(null);
            await refresh();
            window.dispatchEvent(new Event("fleet:changed"));
          }}
        />
      ) : null}
    </section>
  );
}

/** One line: free memory, CPUs, load and free disk, as reported. */
export function CapacitySummary({ capacity }: { capacity: CapacitySnapshot }) {
  const { t } = useLingui();
  const { memoryFree, cpuCount, cpuLoad1m, diskFree } = capacity;
  return (
    <>
      {memoryFree === null
        ? t`Memory not reported`
        : t`${(memoryFree / 1024 ** 3).toFixed(1)} GB free`}
      {cpuCount !== null ? ` · ${cpuCount} CPU` : ""}
      {cpuLoad1m !== null ? ` · ${t`Load`} ${cpuLoad1m.toFixed(1)}` : ""}
      {diskFree !== null ? ` · ${t`Disk`} ${(diskFree / 1024 ** 3).toFixed(1)} GB` : ""}
    </>
  );
}

export function CapacityBar({ target }: { target: FleetTarget }) {
  const { t } = useLingui();
  const { memoryFree, memoryTotal } = target.capacity;
  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      <p>
        <CapacitySummary capacity={target.capacity} />
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
  onCancel,
  onSaved,
}: {
  target?: FleetTarget;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useLingui();
  const [kind, setKind] = useState(
    target?.kind === "kubernetes"
      ? "kubernetes"
      : target?.kind === "docker" || target?.kind === "podman"
        ? target.kind
        : "ssh",
  );
  const [name, setName] = useState(target?.name ?? "");
  const [host, setHost] = useState(target?.ssh?.host ?? "");
  const [user, setUser] = useState(target?.ssh?.user ?? "");
  const [port, setPort] = useState(target?.ssh?.port ?? 22);
  const [authentication, setAuthentication] = useState(target?.ssh?.authentication ?? "agent");
  const [keyPath, setKeyPath] = useState("");
  const [jumpHost, setJumpHost] = useState("");
  const [baseDirectory, setBaseDirectory] = useState("~/.ardurbot/computers");
  const [endpoint, setEndpoint] = useState(target?.endpoint ?? "");
  const [context, setContext] = useState(target?.context ?? "");
  const [namespace, setNamespace] = useState("ardurbot");
  const [kubeconfig, setKubeconfig] = useState("");
  const [kubeconfigPath, setKubeconfigPath] = useState("");
  const [resources, setResources] = useState({
    storageSize: "10Gi",
    storageClass: "",
    cpuRequest: "250m",
    cpuLimit: "2",
    memoryRequest: "256Mi",
    memoryLimit: "2Gi",
  });
  const [tls, setTls] = useState({ ca: "", cert: "", key: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const settings = ComputerConnectionSettingsSchema.parse({
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
                endpoint,
                ...(target?.context && endpoint === target.endpoint
                  ? { dockerContext: target.context }
                  : {}),
              }),
      });
      await rpc.computer.connect({
        name,
        settings,
        ...(kind === "ssh" && authentication === "private-key" ? { privateKeyPath: keyPath } : {}),
        ...(kind === "kubernetes" && kubeconfig ? { kubeconfig } : {}),
        ...(kind === "kubernetes" && kubeconfigPath ? { kubeconfigPath } : {}),
        ...(endpoint.startsWith("tcp://") ? { tlsPaths: tls } : {}),
      });
      await onSaved();
    } catch {
      setError(t`Could not add the computer. Check its settings and try again.`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      onSubmit={(event) => void save(event)}
      className="space-y-3 rounded-lg border border-border p-4"
    >
      <h4 className="font-medium">
        <Trans>Add computer</Trans>
      </h4>
      <NativeSelect
        aria-label={t`Connection type`}
        value={kind}
        onChange={(event) => setKind(event.target.value)}
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
              required
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
                  onChange={(event) => setResources({ ...resources, [key]: event.target.value })}
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
                  required
                  value={tls[key]}
                  onChange={(event) => setTls({ ...tls, [key]: event.target.value })}
                />
              ))
            : null}
        </>
      )}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          <Trans>Add</Trans>
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          <Trans>Cancel</Trans>
        </Button>
      </div>
    </form>
  );
}
