import type { AccountProfileInput, AccountSettings } from "@ardurbot/contracts";
import { WorkTypeSchema } from "@ardurbot/contracts";
import {
  BotAvatar,
  Button,
  Field,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
  Textarea,
  Toggle,
} from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { SuccessPop } from "../../components/ai/primitives";
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
    <section aria-labelledby="account-profile-title" className="space-y-5">
      <h3 id="account-profile-title" className="text-base font-medium">{t`Profile`}</h3>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save("profile");
        }}
        onChange={() => setSaved("")}
      >
        <fieldset disabled={busy} className="space-y-4">
          <legend className="mb-2 text-sm font-medium">{t`Avatar`}</legend>
          <div className="flex gap-2">
            {(["robot", "organic"] as const).map((style) => (
              <Toggle
                key={style}
                variant="outline"
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
          <Field>
            <FieldLabel htmlFor="account-full-name">{t`Full name`}</FieldLabel>
            <Input
              id="account-full-name"
              autoComplete="name"
              maxLength={120}
              required
              value={profile.name}
              onChange={(event) => setProfile({ ...profile, name: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="account-display-name">{t`What should your bots call you?`}</FieldLabel>
            <Input
              id="account-display-name"
              autoComplete="nickname"
              maxLength={60}
              value={profile.displayName}
              onChange={(event) => setProfile({ ...profile, displayName: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="account-work">{t`What best describes your work?`}</FieldLabel>
            <NativeSelect
              id="account-work"
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
          </Field>
        </fieldset>
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={busy || !profile.name.trim()}>{t`Save`}</Button>
          {saved === "profile" ? <SuccessPop label={t`Saved`} /> : null}
        </div>
      </form>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save("instructions");
        }}
      >
        <Field>
          <FieldLabel htmlFor="account-instructions">{t`Instructions for all bots`}</FieldLabel>
          <Textarea
            id="account-instructions"
            rows={5}
            maxLength={4000}
            disabled={busy || !account.canEditInstructions}
            value={instructions}
            onChange={(event) => {
              setInstructions(event.target.value);
              setSaved("");
            }}
          />
        </Field>
        {account.canEditInstructions ? (
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={busy}>{t`Save`}</Button>
            {saved === "instructions" ? <SuccessPop label={t`Saved`} /> : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t`Only space owners and admins can edit these instructions.`}</p>
        )}
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
