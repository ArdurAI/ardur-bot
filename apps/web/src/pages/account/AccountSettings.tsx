import type {
  AccountProfileInput,
  AccountSession,
  AvatarStyle,
  LocalDevice,
  AccountSettings as Settings,
} from "@ardurbot/contracts";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  Button,
  Switch,
} from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { authClient } from "../../lib/auth";
import { rpc } from "../../lib/rpc";
import { AccountProfile } from "./AccountProfile";
import { ActiveSessionsTable, LocalDevicesTable } from "./AccountTables";

export function AccountSettings({
  onProfileSaved,
  onAvatarStyleChange,
  onBusyChange,
}: {
  onProfileSaved?: (profile: AccountProfileInput) => void;
  onAvatarStyleChange?: (style: AvatarStyle) => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
} = {}) {
  const { t } = useLingui();
  const [account, setAccount] = useState<Settings | null>(null);
  const [devices, setDevices] = useState<LocalDevice[]>([]);
  const [sessions, setSessions] = useState<AccountSession[]>([]);
  const [currentRegistrationId, setRegistrationId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [error, setError] = useState("");
  const [sessionError, setSessionError] = useState(false);
  const [devicesError, setDevicesError] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [copied, setCopied] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    onBusyChange?.(busy || profileBusy);
    return () => onBusyChange?.(false);
  }, [busy, profileBusy, onBusyChange]);

  useEffect(() => {
    if (busy) return;
    let active = true;
    const timer = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void rpc.account
        .localDevices()
        .then((rows) => {
          if (active) {
            setDevices(rows);
            setDevicesError(false);
          }
        })
        .catch(() => {
          if (active) setDevicesError(true);
        });
    }, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [busy]);

  useEffect(() => {
    let active = true;
    void rpc.account
      .get()
      .then((result) => {
        if (active) {
          setAccount(result);
          setError("");
        }
      })
      .catch(() => {
        if (active) setError(t`Could not load account settings. Try again.`);
      });
    void rpc.account
      .sessions()
      .then((result) => {
        if (active) {
          setSessions(result);
          setSessionError(false);
        }
      })
      .catch(() => {
        if (active) setSessionError(true);
      });
    void rpc.account
      .localDevices()
      .then((result) => {
        if (active) {
          setDevices(result);
          setDevicesError(false);
        }
      })
      .catch(() => {
        if (active) setDevicesError(true);
      });
    void window.ardurbotDesktop?.host
      ?.state()
      .then((state) => {
        if (active) setRegistrationId(state.configured ? state.registrationId : undefined);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [reload, t]);

  async function perform(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch {
      setError(t`Could not update account settings. Try again.`);
    } finally {
      setBusy(false);
    }
  }
  async function revoke(session: AccountSession) {
    await rpc.account.revokeSession({ id: session.id });
    if (session.current) {
      await authClient.signOut();
      window.location.assign("/sign-in");
      return;
    }
    setSessions((rows) => rows.filter((row) => row.id !== session.id));
  }
  async function disconnect(device: LocalDevice) {
    await rpc.account.disconnectDevice({ id: device.id, kind: device.kind });
    setDevices((rows) => rows.filter((row) => row.kind !== device.kind || row.id !== device.id));
    if (
      device.kind === "host" &&
      currentRegistrationId &&
      device.registrationId === currentRegistrationId
    )
      await window.ardurbotDesktop?.host?.clear();
    setAccount(await rpc.account.get());
  }
  return (
    <div className="space-y-8" data-testid="account-settings" aria-busy={busy}>
      {error ? (
        <div role="alert" className="text-sm text-destructive">
          {error}{" "}
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => setReload((value) => value + 1)}
          >{t`Retry`}</Button>
        </div>
      ) : null}
      {account ? (
        <>
          <AccountProfile
            key={account.spaceId}
            account={account}
            onBusyChange={setProfileBusy}
            onSaved={async (profile) => {
              await onAvatarStyleChange?.(profile.avatarStyle);
              authClient.$store.notify("$sessionSignal");
              onProfileSaved?.(profile);
            }}
          />
          <section
            className="space-y-4 border-t border-border pt-6"
            aria-labelledby="account-actions-title"
          >
            <h3 id="account-actions-title" className="text-base font-medium">{t`Account`}</h3>
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm">{t`Log out of all devices`}</span>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setConfirmLogout(true)}
              >{t`Log out`}</Button>
            </div>
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0 text-sm">
                <span className="block text-muted-foreground">{t`Space ID`}</span>
                <code className="break-all">{account.spaceId}</code>
              </div>
              <Button
                variant="ghost"
                aria-label={t`Copy Space ID`}
                onClick={() =>
                  void perform(async () => {
                    await navigator.clipboard.writeText(account.spaceId);
                    setCopied(true);
                  })
                }
              >
                {copied ? t`Copied` : t`Copy`}
              </Button>
            </div>
          </section>
          <section className="border-t border-border pt-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <label
                  htmlFor="account-trusted-devices"
                  className="text-sm font-medium"
                >{t`Require trusted devices`}</label>
                <p
                  id="account-trust-description"
                  className="mt-1 text-sm text-muted-foreground"
                >{t`Verify each new device before it can connect to your computer remotely`}</p>
              </div>
              <Switch
                id="account-trusted-devices"
                aria-describedby="account-trust-description"
                checked={account.requireTrustedDevices}
                disabled={
                  busy ||
                  !account.canManageDevices ||
                  (!account.desktopAvailable && !account.requireTrustedDevices)
                }
                onCheckedChange={(required) =>
                  void perform(async () => {
                    const result = await rpc.account.setTrustedDevices({ required });
                    setAccount({ ...account, requireTrustedDevices: result.required });
                  })
                }
              />
            </div>
            {!account.desktopAvailable ? (
              <p className="mt-2 text-sm text-muted-foreground">{t`Connect a desktop app to approve new devices.`}</p>
            ) : null}
          </section>
        </>
      ) : !error ? (
        <p
          role="status"
          className="text-sm text-muted-foreground"
        >{t`Loading account settings…`}</p>
      ) : null}
      <section
        className="space-y-2 border-t border-border pt-6"
        aria-labelledby="account-local-devices-title"
      >
        <h3
          id="account-local-devices-title"
          className="text-base font-medium"
        >{t`Local devices`}</h3>
        <p className="text-sm text-muted-foreground">{t`Computers that can run tasks with access to local files, computer use, browser use, and local MCPs`}</p>
        {devicesError ? (
          <p role="alert" className="text-sm text-destructive">
            {t`Could not load devices.`}{" "}
            <Button
              variant="ghost"
              onClick={() => setReload((value) => value + 1)}
            >{t`Retry`}</Button>
          </p>
        ) : (
          <LocalDevicesTable
            devices={devices}
            currentRegistrationId={currentRegistrationId}
            canManage={account?.canManageDevices ?? false}
            busy={busy}
            onApprove={(id) =>
              void perform(async () => {
                await rpc.account.approveDevice({ id });
                setDevices(await rpc.account.localDevices());
              })
            }
            onDisconnect={(device) => void perform(() => disconnect(device))}
          />
        )}
      </section>
      <section
        className="space-y-2 border-t border-border pt-6"
        aria-labelledby="account-sessions-title"
      >
        <h3 id="account-sessions-title" className="text-base font-medium">{t`Active sessions`}</h3>
        {sessionError ? (
          <p role="alert" className="text-sm text-destructive">
            {t`Sign in again to manage sessions.`}{" "}
            <Button
              variant="ghost"
              onClick={() =>
                void perform(async () => {
                  await authClient.signOut();
                  window.location.assign("/sign-in");
                })
              }
            >{t`Sign in`}</Button>
          </p>
        ) : (
          <ActiveSessionsTable
            sessions={sessions}
            busy={busy}
            onRevoke={(session) => void perform(() => revoke(session))}
          />
        )}
      </section>
      <AlertDialog
        open={confirmLogout}
        onOpenChange={(open) => {
          if (!busy) setConfirmLogout(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogTitle>{t`Log out of all devices`}</AlertDialogTitle>
          <AlertDialogDescription>{t`This signs out every other session and keeps this one signed in.`}</AlertDialogDescription>
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => setConfirmLogout(false)}
            >{t`Cancel`}</Button>
            <Button
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  await rpc.account.revokeOtherSessions();
                  setSessions((rows) => rows.filter((row) => row.current));
                  setConfirmLogout(false);
                })
              }
            >{t`Log out`}</Button>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default AccountSettings;
