import { Button, Field, FieldLabel, Input } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useId, useState } from "react";
import { SuccessPop } from "../../components/ai/primitives";
import { SettingsRow } from "../../components/SettingsRow";
import { authClient } from "../../lib/auth";

export function AccountSignIn({
  email,
  onBusyChange,
  onChanged,
}: {
  email?: string | null;
  onBusyChange: (busy: boolean) => void;
  onChanged: () => void;
}) {
  const { t } = useLingui();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    onBusyChange(pending);
    return () => onBusyChange(false);
  }, [pending, onBusyChange]);

  async function changePassword() {
    if (pending) return;
    if (newPassword !== confirmation) {
      setError(t`Passwords do not match`);
      return;
    }
    setPending(true);
    setSaved(false);
    setError(null);
    try {
      const result = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      });
      if (result.error) {
        setError(result.error.message ?? t`Could not change password`);
        return;
      }
      setCurrentPassword("");
      setNewPassword("");
      setConfirmation("");
      setSaved(true);
      onChanged();
    } catch {
      setError(t`Could not reach the server`);
    } finally {
      setPending(false);
    }
  }

  return (
    <SettingsRow
      label={t`Password`}
      content={
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void changePassword();
          }}
        >
          <div className="mt-3 grid gap-3">
            <input
              type="text"
              name="username"
              autoComplete="username"
              value={email ?? ""}
              readOnly
              tabIndex={-1}
              aria-hidden="true"
              className="sr-only"
            />
            <SettingsPasswordInput
              label={t`Current password`}
              autoComplete="current-password"
              value={currentPassword}
              onChange={setCurrentPassword}
            />
            <SettingsPasswordInput
              label={t`New password`}
              autoComplete="new-password"
              value={newPassword}
              onChange={setNewPassword}
            />
            <SettingsPasswordInput
              label={t`Confirm password`}
              autoComplete="new-password"
              value={confirmation}
              onChange={setConfirmation}
            />
          </div>
          {error ? (
            <p role="alert" className="mt-3 text-[12.5px] text-destructive">
              {error}
            </p>
          ) : null}
          <div className="mt-4 flex items-center gap-3">
            <Button
              className="rounded-full"
              disabled={pending || currentPassword.length < 8 || newPassword.length < 8}
              type="submit"
            >
              {pending ? <Trans>Changing…</Trans> : <Trans>Change password</Trans>}
            </Button>
            {saved ? <SuccessPop label={t`Password updated`} /> : null}
          </div>
        </form>
      }
    >
      {email ? <span className="text-sm text-muted-foreground">{email}</span> : null}
    </SettingsRow>
  );
}

function SettingsPasswordInput({
  label,
  autoComplete,
  value,
  onChange,
}: {
  label: string;
  autoComplete: "current-password" | "new-password";
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type="password"
        autoComplete={autoComplete}
        minLength={8}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}
