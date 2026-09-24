import { Button, NativeSelect, NativeSelectOption, Switch } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import type {
  PermissionStatus,
  Shortcut,
  ShortcutAction,
  SystemBridge,
  SystemPreferences,
  SystemState,
} from "./bridge";
import { systemBridge } from "./bridge";
import { connectedBrowsers } from "./browsers";
import { DispatchSetting } from "./DispatchSetting";

function Row({
  id,
  label,
  description,
  children,
}: {
  id: string;
  label: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-4 last:border-0">
      <div className="min-w-0 flex-1">
        <label id={`${id}-label`} htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        {description ? (
          <p id={`${id}-description`} className="mt-1 text-sm text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function SystemPage({ bridge = systemBridge() }: { bridge?: SystemBridge }) {
  const { t } = useLingui();
  const [state, setState] = useState<SystemState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [browsers, setBrowsers] = useState<ReturnType<typeof connectedBrowsers>>([]);
  const [browserError, setBrowserError] = useState(false);
  const revision = useRef(0);

  useEffect(() => {
    if (!bridge) return;
    let active = true;
    const refresh = () => {
      const requestRevision = revision.current;
      void bridge
        .state()
        .then((value) => {
          if (active && requestRevision === revision.current) setState(value);
        })
        .catch(() => {
          if (active) setError(t`Could not read system settings; try again.`);
        });
    };
    refresh();
    const timer = setInterval(refresh, 2_000);
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [bridge, t]);

  useEffect(() => {
    if (!bridge) return;
    let active = true;
    void rpc.computer
      .list()
      .then((value) => {
        if (active) setBrowsers(connectedBrowsers(value));
      })
      .catch(() => {
        if (active) setBrowserError(true);
      });
    return () => {
      active = false;
    };
  }, [bridge]);

  async function act(work: () => Promise<SystemState> | Promise<void>) {
    revision.current += 1;
    setBusy(true);
    setError(null);
    try {
      const next = await work();
      if (next) setState(next);
    } catch (error) {
      setError(
        error instanceof Error && error.message.includes("That shortcut is already in use")
          ? t`That shortcut is already in use; choose another.`
          : t`Could not change this setting; try again.`,
      );
    } finally {
      revision.current += 1;
      setBusy(false);
    }
  }
  if (!bridge) return null;
  if (!state) return <div role="status">{error ?? t`Loading system settings…`}</div>;
  const toggle = (key: keyof SystemPreferences, label: string, description: string) => (
    <Row id={`system-${key}`} label={label} description={description} key={key}>
      <Switch
        id={`system-${key}`}
        aria-describedby={`system-${key}-description`}
        checked={Boolean(state.preferences[key])}
        disabled={busy}
        onCheckedChange={(value) => void act(() => bridge.set(key, value))}
      />
    </Row>
  );
  const shortcutLabel = (shortcut: Shortcut) =>
    shortcut === "Off"
      ? t`Off`
      : shortcut
          .replace("CommandOrControl", state.platform === "darwin" ? "⌘" : "Ctrl")
          .replace("Control", state.platform === "darwin" ? "⌃" : "Ctrl")
          .replace("Alt", state.platform === "darwin" ? "⌥" : "Alt")
          .replace("Shift", "⇧");
  const shortcut = (key: ShortcutAction, label: string, description: string) => (
    <Row id={`system-${key}`} label={label} description={description}>
      <NativeSelect
        id={`system-${key}`}
        aria-describedby={`system-${key}-description`}
        value={state.preferences[key]}
        disabled={busy}
        onChange={(event) => {
          const next = state.shortcutOptions[key].find((option) => option === event.target.value);
          if (next) void act(() => bridge.set(key, next));
        }}
      >
        {state.shortcutOptions[key].map((value) => (
          <NativeSelectOption key={value} value={value}>
            {shortcutLabel(value)}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </Row>
  );
  const permissionLabel = (status: PermissionStatus) =>
    ({
      granted: t`Granted`,
      denied: t`Not granted`,
      restricted: t`Restricted`,
      "not-determined": t`Not requested`,
      unknown: t`Unknown`,
    })[status];

  return (
    <div data-testid="system-settings" className="space-y-6">
      {error ? (
        <div className="flex items-center gap-3">
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void act(() => bridge.state())}
          >{t`Retry`}</Button>
        </div>
      ) : null}
      <section aria-label={t`System`}>
        <Row id="system-version" label={t`Desktop app version`}>
          <span className="text-sm text-muted-foreground">{state.version}</span>
        </Row>
        {state.startupSupported
          ? toggle(
              "runOnStartup",
              t`Run on startup`,
              t`Automatically start when you log in to your computer.`,
            )
          : null}
        {shortcut(
          "quickAccess",
          t`Quick access shortcut`,
          t`Message from anywhere on your desktop.`,
        )}
        {shortcut(
          "voice",
          t`Voice shortcut`,
          t`Speak from anywhere on your desktop; press again when you are done.`,
        )}
        {shortcut(
          "dictation",
          t`Dictation shortcut`,
          t`Start or stop dictation in the chat you are typing in.`,
        )}
        {state.shortcutError ? (
          <p
            role="alert"
            className="text-sm text-destructive"
          >{t`A saved shortcut is unavailable; choose another.`}</p>
        ) : null}
        {state.platform === "darwin"
          ? toggle("menuBar", t`Menu bar`, t`Show in the menu bar.`)
          : null}
        {state.menuBarError ? (
          <p
            role="alert"
            className="text-sm text-destructive"
          >{t`Could not show the menu bar item; try again.`}</p>
        ) : null}
        {state.mode === "new"
          ? toggle(
              "keepAwake",
              t`Keep computer awake`,
              t`Prevent idle sleep while routines are enabled; your display can turn off, and closing the lid still puts the computer to sleep.`,
            )
          : null}
        {state.awakeRoutines > 0 ? (
          <p
            role="status"
            className="text-sm text-muted-foreground"
          >{t`Awake for ${state.awakeRoutines} routines`}</p>
        ) : null}
        <Row
          id="system-storage"
          label={t`Storage folder`}
          description={
            state.mode === "existing"
              ? t`This folder is managed by the server.`
              : state.storage.path
                ? t`Your artifacts and scheduled tasks are stored at ${state.storage.path}.`
                : t`Your artifacts and scheduled tasks are stored in Docker volumes.`
          }
        >
          {state.mode === "new" && state.storage.canMove ? (
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void act(() => bridge.moveStorage(true))}
              >{t`Use recommended`}</Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void act(() => bridge.moveStorage(false))}
              >{t`Change`}</Button>
            </div>
          ) : null}
        </Row>
        {state.storage.progress ? (
          <p role="status" className="text-sm text-muted-foreground">
            {state.storage.progress}
          </p>
        ) : null}
      </section>
      <DispatchSetting />
      <section aria-labelledby="system-browser-heading">
        <h3 id="system-browser-heading" className="text-base font-medium">{t`Browser use`}</h3>
        <Row
          id="system-browsers"
          label={t`Connected browsers`}
          description={t`Computer browsers that your bots can use.`}
        >
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                setBrowserError(false);
                try {
                  setBrowsers(connectedBrowsers(await rpc.computer.list()));
                } catch {
                  setBrowserError(true);
                }
              })
            }
          >{t`Recheck`}</Button>
        </Row>
        {browserError ? (
          <p
            role="alert"
            className="text-sm text-destructive"
          >{t`Could not check browsers; try Recheck.`}</p>
        ) : (
          <ul className="text-sm text-muted-foreground">
            {browsers.map((browser) => (
              <li key={browser.id}>{t`Chromium — ${browser.name}`}</li>
            ))}
            {browsers.length === 0 ? <li>{t`No connected browsers`}</li> : null}
          </ul>
        )}
        {toggle(
          "openLinksInBrowser",
          t`Open links in built-in browser`,
          t`Open chat links in the desktop app.`,
        )}
      </section>
      {state.platform === "darwin" && state.permissions ? (
        <section aria-labelledby="system-permissions-heading">
          <h3 id="system-permissions-heading" className="text-base font-medium">
            {t`Computer use`}{" "}
            <span className="ms-2 rounded border border-border px-1.5 py-0.5 text-xs font-normal text-muted-foreground">{t`Beta`}</span>
          </h3>
          {(["accessibility", "screen"] as const).map((permission) => (
            <Row
              key={permission}
              id={`system-${permission}`}
              label={permission === "accessibility" ? t`Accessibility` : t`Screen recording`}
            >
              <div className="flex items-center gap-3">
                <span className="text-sm text-muted-foreground">
                  {permissionLabel(state.permissions![permission])}
                </span>
                <Button
                  variant="outline"
                  disabled={busy}
                  aria-label={
                    permission === "accessibility"
                      ? t`Open Accessibility settings`
                      : t`Open Screen recording settings`
                  }
                  onClick={() => void act(() => bridge.openPermission(permission))}
                >{t`Open System Settings`}</Button>
              </div>
            </Row>
          ))}
        </section>
      ) : null}
    </div>
  );
}

export default function SystemSettings() {
  return <SystemPage />;
}
