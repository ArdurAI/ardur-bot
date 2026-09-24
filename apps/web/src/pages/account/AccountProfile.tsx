import type { AccountProfileInput, AccountSettings } from "@ardurbot/contracts";
import { WorkTypeSchema } from "@ardurbot/contracts";
import {
  BotAvatar,
  Button,
  Input,
  NativeSelect,
  NativeSelectOption,
  Textarea,
  Toggle,
} from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { SuccessPop } from "../../components/ai/primitives";
import { SettingsRow } from "../../components/SettingsRow";
import { rpc } from "../../lib/rpc";

export function AccountProfile({
  account,
  onSaved,
  onBusyChange,
}: {
  account: AccountSettings;
  onSaved?: (profile: AccountProfileInput) => void | Promise<void>;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useLingui();
  const [profile, setProfile] = useState<AccountProfileInput>({
    name: account.name,
    displayName: account.displayName,
    workType: account.workType,
    avatarStyle: account.avatarStyle,
  });
  const [instructions, setInstructions] = useState(account.instructions);
  const [revision, setRevision] = useState(account.instructionsRevision);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  const workOptions = [
    ["", t`Select`],
    ["engineering", t`Engineering`],
    ["design", t`Design`],
    ["research", t`Research`],
    ["operations", t`Operations`],
    ["education", t`Education`],
    ["other", t`Other`],
  ];

  async function save(section: "profile" | "instructions") {
    if (busy) return;
    setBusy(true);
    setError("");
    setConflict(false);
    setSaved("");
    try {
      if (section === "profile") {
        const result = await rpc.account.updateProfile(profile);
        setProfile(result);
        await onSaved?.(result);
      } else {
        const result = await rpc.account.updateInstructions({ instructions, revision });
        setRevision(result.revision);
      }
      setSaved(section);
    } catch (cause) {
      setConflict(
        !!cause && typeof cause === "object" && "code" in cause && cause.code === "CONFLICT",
      );
      setError(
        cause && typeof cause === "object" && "code" in cause && cause.code === "CONFLICT"
          ? t`Instructions changed. Reload before saving.`
          : t`Could not save changes. Try again.`,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section data-settings-group aria-labelledby="account-profile-title" className="space-y-5">
      <h3 id="account-profile-title" className="text-base font-medium">{t`Profile`}</h3>
      <form
        data-settings-group
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save("profile");
        }}
        onChange={() => setSaved("")}
      >
        <fieldset disabled={busy}>
          <SettingsRow label={t`Avatar`}>
            <div className="flex gap-2" data-testid="avatar-style-select">
              {(["robot", "organic"] as const).map((style) => (
                <Toggle
                  key={style}
                  variant="outline"
                  data-testid={`avatar-style-${style}`}
                  pressed={profile.avatarStyle === style}
                  onPressedChange={() => {
                    setProfile({ ...profile, avatarStyle: style });
                    setSaved("");
                  }}
                  className="h-auto gap-2 p-2"
                >
                  <BotAvatar
                    color="currentColor"
                    identity="account-avatar"
                    size={32}
                    variant={style}
                  />
                  <span>{style === "robot" ? t`Robot` : t`Organic`}</span>
                </Toggle>
              ))}
            </div>
          </SettingsRow>
          <SettingsRow label={t`Full name`}>
            <Input
              id="account-full-name"
              aria-label={t`Full name`}
              className="w-40 sm:w-64"
              autoComplete="name"
              maxLength={120}
              required
              value={profile.name}
              onChange={(event) => setProfile({ ...profile, name: event.target.value })}
            />
          </SettingsRow>
          <SettingsRow label={t`What should your bots call you?`}>
            <Input
              id="account-display-name"
              aria-label={t`What should your bots call you?`}
              className="w-40 sm:w-64"
              autoComplete="nickname"
              maxLength={60}
              value={profile.displayName}
              onChange={(event) => setProfile({ ...profile, displayName: event.target.value })}
            />
          </SettingsRow>
          <SettingsRow label={t`What best describes your work?`}>
            <NativeSelect
              id="account-work"
              aria-label={t`What best describes your work?`}
              value={profile.workType}
              onChange={(event) =>
                setProfile({ ...profile, workType: WorkTypeSchema.parse(event.target.value) })
              }
            >
              {workOptions.map(([value, label]) => (
                <NativeSelectOption key={value} value={value}>
                  {label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </SettingsRow>
        </fieldset>
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={busy || !profile.name.trim()}>{t`Save`}</Button>
          {saved === "profile" ? <SuccessPop label={t`Saved`} /> : null}
        </div>
      </form>
      <form
        data-settings-group
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save("instructions");
        }}
      >
        <SettingsRow
          label={t`Instructions for all bots`}
          content={
            <Textarea
              id="account-instructions"
              aria-label={t`Instructions for all bots`}
              className="mt-3"
              rows={5}
              maxLength={4000}
              disabled={busy || !account.canEditInstructions}
              value={instructions}
              onChange={(event) => {
                setInstructions(event.target.value);
                setSaved("");
              }}
            />
          }
        >
          {account.canEditInstructions ? (
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={busy}>{t`Save`}</Button>
              {saved === "instructions" ? <SuccessPop label={t`Saved`} /> : null}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t`Only space owners and admins can edit these instructions.`}</p>
          )}
        </SettingsRow>
      </form>
      {error ? (
        <div role="alert" className="text-sm text-destructive">
          {error}
          {conflict ? (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void rpc.account
                  .get()
                  .then((latest) => {
                    setInstructions(latest.instructions);
                    setRevision(latest.instructionsRevision);
                    setConflict(false);
                    setError("");
                  })
                  .catch(() => setError(t`Could not load account settings. Try again.`))
                  .finally(() => setBusy(false));
              }}
            >{t`Reload`}</Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
