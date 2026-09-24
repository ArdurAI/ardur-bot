import type {
  DesktopDeviceListenerState,
  DeviceGrantView,
  PairingPayload,
} from "@ardurbot/contracts";
import { DEFAULT_DEVICE_SCOPES } from "@ardurbot/contracts";
import { Button, Input, Switch } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { toQR } from "toqr";
import { knownActionError } from "../lib/known-action-error";
import { rpc } from "../lib/rpc";
import { ChannelPairingSettings } from "./ChannelPairingSettings";

export function PairingQr({ payload }: { payload: PairingPayload }) {
  const { t } = useLingui();
  const data = toQR(JSON.stringify(payload));
  const size = Math.sqrt(data.length);
  const path = Array.from(data, (on, i) =>
    on ? `M${(i % size) + 4},${Math.floor(i / size) + 4}h1v1h-1z` : "",
  ).join("");
  return (
    <svg
      role="img"
      aria-label={t`Pair device`}
      data-theme="light"
      viewBox={`0 0 ${size + 8} ${size + 8}`}
      className="h-72 w-72 bg-background text-foreground"
      shapeRendering="crispEdges"
    >
      <title>{t`Pair device`}</title>
      <path fill="currentColor" d={path} />
    </svg>
  );
}

export function DevicesSettings({ owner }: { owner: boolean }) {
  const { t } = useLingui();
  const [devices, setDevices] = useState<DeviceGrantView[]>([]);
  const [pending, setPending] = useState<
    Array<{ id: string; deviceName: string; publicKeyFingerprint: string }>
  >([]);
  const [fingerprint, setFingerprint] = useState("");
  const [pairing, setPairing] = useState<{
    payload: PairingPayload;
    shortCode: string;
    expiresAt: string;
  } | null>(null);
  const [listener, setListener] = useState<DesktopDeviceListenerState | null>(null);
  const [consequential, setConsequential] = useState(false);
  const [delegate, setDelegate] = useState(false);
  const [rename, setRename] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const desktop = window.ardurbotDesktop?.devices;
  async function refresh() {
    const state = await rpc.devices.list();
    setDevices(state.devices);
    setPending(state.pending);
    setFingerprint(state.fingerprint);
  }
  async function act(work: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await work();
      await refresh();
    } catch (error) {
      setError(
        knownActionError(
          error,
          [
            "Open Devices on your Mac.",
            "Phone pairing needs a home run by this app. Set up This computer to use it.",
            "Start your home before pairing a phone.",
            "Update your home before pairing a phone.",
            "Pair your phone again with this home.",
            "Connect this Mac to your network first.",
            "Pair and manage devices from the home owner account.",
            "These permissions are unavailable at home.",
            "This device is no longer available.",
            "This pairing code is unavailable; start pairing again at home.",
            "Pairing is locked for 15 minutes; try again later.",
          ],
          t`This change could not finish; try again.`,
        ),
      );
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!owner) return;
    void refresh().catch(() => setError(t`Devices are unavailable; reconnect to your home.`));
    void desktop
      ?.state()
      .then(setListener)
      .catch(() => setError(t`Restart the desktop app to update it.`));
    const timer = setInterval(() => {
      void refresh().catch(() => undefined);
    }, 5_000);
    return () => clearInterval(timer);
  }, [owner, desktop, t]);
  if (!owner) return <p>{t`Manage devices from the home owner account.`}</p>;
  return (
    <div data-testid="devices-settings" className="space-y-5">
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
      <details>
        <summary>{t`Home fingerprint`}</summary>
        <p className="break-all font-mono text-xs">{fingerprint}</p>
      </details>
      {desktop && listener && !listener.available ? (
        <p role="status">
          {listener.available === undefined
            ? t`Restart the desktop app to update it.`
            : t`Phone pairing needs a home run by this app. Set up This computer to use it.`}
        </p>
      ) : null}
      {desktop && listener?.available ? (
        <div className="flex items-center justify-between gap-3">
          <label htmlFor="lan-listener">{t`Your phone can reach this Mac on your network.`}</label>
          <Switch
            id="lan-listener"
            checked={listener.enabled}
            disabled={busy}
            onCheckedChange={(enabled) =>
              void act(async () => {
                setListener(await desktop.setEnabled(enabled));
                setPairing(null);
              })
            }
          />
        </div>
      ) : null}
      <Button
        disabled={busy}
        onClick={() =>
          void act(async () =>
            setPairing(
              await rpc.pairing.start({
                scopes: [
                  ...DEFAULT_DEVICE_SCOPES,
                  ...(consequential ? ["consequential" as const] : []),
                  ...(delegate ? ["delegate" as const] : []),
                ],
                hints: listener?.hints ?? [],
              }),
            ),
          )
        }
      >{t`Pair device`}</Button>
      <ChannelPairingSettings />
      <details>
        <summary>{t`Device permissions`}</summary>
        <div className="mt-3 space-y-3">
          <label htmlFor="device-consequential" className="flex items-center justify-between gap-3">
            {t`Allow actions after presence confirmation`}
            <Switch
              id="device-consequential"
              checked={consequential}
              onCheckedChange={setConsequential}
            />
          </label>
          <label htmlFor="device-delegate" className="flex items-center justify-between gap-3">
            {t`Allow delegation`}
            <Switch id="device-delegate" checked={delegate} onCheckedChange={setDelegate} />
          </label>
        </div>
      </details>
      {pairing ? (
        <div className="space-y-2" data-testid="device-pairing">
          <PairingQr payload={pairing.payload} />
          <p>
            {t`Pairing code`}: <strong className="font-mono">{pairing.shortCode}</strong>
          </p>
          <p className="text-sm text-muted-foreground">{t`Expires in five minutes.`}</p>
          <details>
            <summary>{t`Enter a code instead`}</summary>
            <p>{t`Confirm the phone fingerprint here before allowing it.`}</p>
            <Input aria-label={t`Home link`} readOnly value={pairing.payload.hints[0] ?? ""} />
            <p className="break-all font-mono text-xs">{pairing.payload.certificateFingerprint}</p>
            <Button
              variant="outline"
              onClick={() => void navigator.clipboard.writeText(JSON.stringify(pairing.payload))}
            >{t`Copy pairing details`}</Button>
          </details>
        </div>
      ) : null}
      {pending.map((request) => (
        <div key={request.id} className="space-y-2 rounded-lg border border-border p-3">
          <p>{request.deviceName}</p>
          <p className="break-all font-mono text-xs">{request.publicKeyFingerprint}</p>
          <Button
            disabled={busy}
            onClick={() => void act(() => rpc.pairing.confirm({ id: request.id, allow: true }))}
          >{t`Allow device`}</Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void act(() => rpc.pairing.confirm({ id: request.id, allow: false }))}
          >{t`Deny`}</Button>
        </div>
      ))}
      <ul className="space-y-3">
        {devices.map((device) => (
          <li key={device.id} className="space-y-2 rounded-lg border border-border p-3">
            <p className="font-medium">
              {device.deviceName}
              {device.revokedAt ? ` · ${t`Revoked`}` : ""}
            </p>
            <p className="text-sm text-muted-foreground">{device.scopes.join(", ")}</p>
            <p className="text-sm">
              {t`Last used`}:{" "}
              {device.lastUsedAt ? new Date(device.lastUsedAt).toLocaleString() : t`Never`}
            </p>
            {device.kind !== "channel" ? (
              <p className="text-sm">
                {t`Last present`}:{" "}
                {device.lastPresenceAt
                  ? new Date(device.lastPresenceAt).toLocaleString()
                  : t`Never`}
              </p>
            ) : null}
            {!device.revokedAt ? (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => setRename({ id: device.id, name: device.deviceName })}
                >{t`Rename`}</Button>
                <Button
                  variant="destructive"
                  disabled={busy}
                  onClick={() => void act(() => rpc.devices.revoke({ id: device.id }))}
                >{t`Revoke`}</Button>
              </div>
            ) : null}
            {rename?.id === device.id ? (
              <form
                className="flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void act(async () => {
                    await rpc.devices.rename({ id: device.id, deviceName: rename.name });
                    setRename(null);
                  });
                }}
              >
                <Input
                  aria-label={t`Device name`}
                  maxLength={80}
                  required
                  value={rename.name}
                  onChange={(event) => setRename({ ...rename, name: event.target.value })}
                />
                <Button disabled={busy} type="submit">{t`Save`}</Button>
              </form>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
