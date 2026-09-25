import type { NotificationCategory, PreferencesPatch } from "@ardurbot/contracts";
import { Button, NativeSelect, NativeSelectOption, Switch, Toggle } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { usePreferences } from "../../components/PreferencesProvider";
import { SettingsRow } from "../../components/SettingsRow";
import { approvalPolicyCopy } from "../../lib/approval-policy-copy";
import { requestBrowserNotificationPermission } from "../../lib/browser-notifications";
import { desktopBridge } from "../../lib/desktop";
import { rpc } from "../../lib/rpc";
import { AccountLanguage } from "../account/AccountLanguage";
import { SettingsSupportLinks } from "../settings-support-links";
import type { SettingsPageProps } from "../settings-types";
import { OpenToSetting } from "../shell/OpenToSetting";

export default function GeneralSettings({
  navigate,
  isDeploymentOwner,
  onBusyChange,
}: SettingsPageProps) {
  const { t, i18n } = useLingui();
  const { preferences, ready, update, reload } = usePreferences();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [folders, setFolders] = useState<number | null>(null);
  const [keepRunning, setKeepRunning] = useState<boolean | null>(null);
  const [dispatchPush, setDispatchPush] = useState(false);
  const [desktopNotifications, setDesktopNotifications] = useState(false);
  const [webPermission, setWebPermission] = useState(() =>
    typeof Notification === "undefined" ? "denied" : Notification.permission,
  );
  const desktop = desktopBridge();
  useEffect(() => {
    let active = true;
    void Promise.all([
      isDeploymentOwner ? rpc.host.status().catch(() => null) : null,
      desktop?.host?.state().catch(() => null),
    ])
      .then(([remote, state]) => {
        if (!active) return;
        const roots = state?.configured ? state.roots : remote?.roots;
        if (roots) setFolders(roots.length);
        if (state?.keepRunning !== undefined) setKeepRunning(state.keepRunning);
      })
      .catch(() => undefined);
    void desktop?.notifications
      ?.supported()
      .then((value) => {
        if (active) setDesktopNotifications(value);
      })
      .catch(() => undefined);
    void rpc.notifications
      .capabilities()
      .then((value) => {
        if (active) setDispatchPush(value.dispatchPush);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [desktop, isDeploymentOwner]);
  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);
  async function perform(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch {
      setError(t`Could not save settings. Try again.`);
    } finally {
      setBusy(false);
    }
  }
  const save = (patch: PreferencesPatch) => void perform(() => update(patch));
  const localNotifications = desktop
    ? desktopNotifications
    : typeof Notification !== "undefined" && window.isSecureContext;
  async function allowNotifications() {
    const permission = await requestBrowserNotificationPermission();
    setWebPermission(permission ?? "denied");
    if (permission !== "granted") {
      setError(t`Allow notifications in your browser settings, then try again.`);
      return false;
    }
    return true;
  }
  async function toggleNotification(key: NotificationCategory, checked: boolean) {
    await perform(async () => {
      if (checked && key !== "dispatchMessages" && !desktop) {
        if (!(await allowNotifications())) return;
      }
      await update({ notifications: { [key]: checked } });
    });
  }
  const notifications = [
    {
      key: "responseCompletions",
      label: t`Response completions`,
      detail: t`Get notified when a response finishes. Useful for long-running tasks.`,
      available: localNotifications,
    },
    {
      key: "routines",
      label: t`Routines`,
      detail: t`When routines finish, cannot run, or need your input.`,
      available: localNotifications,
    },
    {
      key: "approvalsNeeded",
      label: t`Approvals needed`,
      detail: t`When a command needs your approval.`,
      available: localNotifications,
    },
    {
      key: "dispatchMessages",
      label: t`Dispatch messages`,
      detail: t`Push notifications on your phone.`,
      available: dispatchPush,
    },
  ] as const;
  return (
    <div className="space-y-5">
      <OpenToSetting />
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {!ready ? (
        <div role="alert" className="text-sm text-destructive">
          <Trans>Could not load settings. Try again.</Trans>
          <Button variant="outline" onClick={reload}>
            <Trans>Retry</Trans>
          </Button>
        </div>
      ) : null}
      <section data-settings-group>
        <h3 className="text-sm font-medium">
          <Trans>Appearance</Trans>
        </h3>
        <SettingsRow label={t`Theme`}>
          <div className="flex gap-1" data-testid="ui-appearance-select">
            {(
              [
                { value: "system", label: t`System`, icon: Monitor },
                { value: "light", label: t`Light`, icon: Sun },
                { value: "dark", label: t`Dark`, icon: Moon },
              ] as const
            ).map(({ value, label, icon: Icon }) => (
              <Toggle
                key={value}
                variant="outline"
                aria-label={label}
                title={label}
                data-testid={`ui-appearance-${value}`}
                pressed={preferences.theme === value}
                disabled={busy || !ready}
                onPressedChange={() => save({ theme: value })}
              >
                <Icon className="size-4" />
              </Toggle>
            ))}
          </div>
        </SettingsRow>
        <SettingsRow label={t`Chat font`}>
          <NativeSelect
            aria-label={t`Chat font`}
            value={preferences.chatFont}
            disabled={busy || !ready}
            onChange={(event) =>
              save({ chatFont: event.target.value as "sans" | "serif" | "system" })
            }
          >
            <NativeSelectOption value="sans">
              <Trans>Sans</Trans>
            </NativeSelectOption>
            <NativeSelectOption value="serif">
              <Trans>Serif</Trans>
            </NativeSelectOption>
            <NativeSelectOption value="system">
              <Trans>System</Trans>
            </NativeSelectOption>
          </NativeSelect>
        </SettingsRow>
        <SettingsRow
          label={t`Motion`}
          description={t`Reduce animation in streaming responses and other interface elements.`}
        >
          <NativeSelect
            aria-label={t`Motion`}
            value={preferences.motion}
            disabled={busy || !ready}
            onChange={(event) => save({ motion: event.target.value as "system" | "reduced" })}
          >
            <NativeSelectOption value="system">
              <Trans>System</Trans>
            </NativeSelectOption>
            <NativeSelectOption value="reduced">
              <Trans>Reduced</Trans>
            </NativeSelectOption>
          </NativeSelect>
        </SettingsRow>
      </section>
      <AccountLanguage />
      {isDeploymentOwner || keepRunning !== null ? (
        <section data-settings-group>
          <h3 className="text-sm font-medium">
            <Trans>Tasks</Trans>
          </h3>
          {isDeploymentOwner ? (
            <SettingsRow label={t`Trusted folders`} description={i18n._(approvalPolicyCopy)}>
              {folders !== null ? (
                <span className="text-sm text-muted-foreground">{folders}</span>
              ) : null}
              <Button variant="outline" onClick={() => navigate("computer")}>
                <Trans>Manage</Trans>
              </Button>
            </SettingsRow>
          ) : null}
          {keepRunning !== null && desktop?.host?.setKeepRunning ? (
            <SettingsRow label={t`Keep working when the window is closed`}>
              <Switch
                aria-label={t`Keep working when the window is closed`}
                checked={keepRunning}
                disabled={busy}
                onCheckedChange={(checked) =>
                  void perform(async () => {
                    await desktop.host!.setKeepRunning!(checked);
                    setKeepRunning(checked);
                  })
                }
              />
            </SettingsRow>
          ) : null}
        </section>
      ) : null}
      <SettingsRow label={t`Voice`}>
        <Button variant="outline" onClick={() => navigate("voice")}>
          <Trans>Manage</Trans>
        </Button>
      </SettingsRow>
      {notifications.some((item) => item.available) ? (
        <section data-settings-group>
          <h3 className="text-sm font-medium">
            <Trans>Notifications</Trans>
          </h3>
          {!desktop &&
          localNotifications &&
          webPermission !== "granted" &&
          notifications.some(
            (item) => item.key !== "dispatchMessages" && preferences.notifications[item.key],
          ) ? (
            <Button
              variant="outline"
              disabled={busy || !ready}
              onClick={() =>
                void perform(async () => {
                  await allowNotifications();
                })
              }
            >
              <Trans>Allow notifications</Trans>
            </Button>
          ) : null}
          {notifications
            .filter((item) => item.available)
            .map((item) => (
              <SettingsRow key={item.key} label={item.label} description={item.detail}>
                <Switch
                  aria-label={item.label}
                  checked={preferences.notifications[item.key]}
                  disabled={busy || !ready}
                  onCheckedChange={(checked) => void toggleNotification(item.key, checked)}
                />
              </SettingsRow>
            ))}
        </section>
      ) : null}
      <SettingsSupportLinks />
    </div>
  );
}
