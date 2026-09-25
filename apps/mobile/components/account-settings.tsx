import type {
  AccountProfileInput,
  AccountSession,
  AccountSettings,
  LocalDevice,
} from "@ardurbot/contracts";
import { accountDate, accountPage, devicePlatform } from "@ardurbot/core";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Button, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { rpc, signOut } from "../lib/api";
import { explicitSignInRoute } from "../lib/auth-routing";
import { hasPairedDevice } from "../lib/dispatch";
import { useI18n } from "../lib/i18n";
import { presentMessageActionSheet } from "../lib/message-action-sheet";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";
import { useAvatarStyle } from "./avatar-style";

/** Native editing uses an auth session; a paired grant can inspect, but cannot manage accounts. */
export function NativeAccountSettings() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const tokens = useMobileTokens();
  const colorScheme = useResolvedAppearance();
  const { avatarStyle } = useAvatarStyle();
  const [account, setAccount] = useState<AccountSettings | null>(null);
  const [devices, setDevices] = useState<LocalDevice[]>([]);
  const [sessions, setSessions] = useState<AccountSession[]>([]);
  const [paired, setPaired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sessionError, setSessionError] = useState(false);
  const [saved, setSaved] = useState(false);
  const [pageNumber, setPage] = useState(0);
  const [reload, setReload] = useState(0);
  const page = accountPage(sessions, pageNumber);
  const work: Array<[AccountProfileInput["workType"], string]> = [
    ["", t("Select")],
    ["engineering", t("Engineering")],
    ["design", t("Design")],
    ["research", t("Research")],
    ["operations", t("Operations")],
    ["education", t("Education")],
    ["other", t("Other")],
  ];

  useEffect(() => {
    let active = true;
    void (async () => {
      const isPaired = await hasPairedDevice();
      if (!active) return;
      setPaired(isPaired);
      const [profile, local, auth] = await Promise.allSettled([
        rpc<AccountSettings>("account/get"),
        rpc<LocalDevice[]>("account/localDevices"),
        isPaired
          ? Promise.resolve([] as AccountSession[])
          : rpc<AccountSession[]>("account/sessions"),
      ]);
      if (!active) return;
      if (profile.status === "fulfilled") setAccount(profile.value);
      if (local.status === "fulfilled") setDevices(local.value);
      setError(
        profile.status === "rejected" || local.status === "rejected"
          ? t("Could not load account settings. Try again.")
          : "",
      );
      if (auth.status === "fulfilled") setSessions(auth.value);
      setSessionError(auth.status === "rejected");
    })().catch(() => {
      if (active) setError(t("Could not load account settings. Try again."));
    });
    return () => {
      active = false;
    };
  }, [reload, t]);

  async function perform(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      await action();
    } catch {
      setError(t("Could not save changes. Try again."));
    } finally {
      setBusy(false);
    }
  }
  function change(values: Partial<AccountSettings>) {
    if (account) setAccount({ ...account, ...values });
    setSaved(false);
  }
  const text = { color: tokens.foreground };
  const muted = { color: tokens.mutedForeground };
  const input = [styles.input, text, { borderColor: tokens.border }];
  const field = (
    label: string,
    value: string,
    onChangeText: (value: string) => void,
    maxLength: number,
    multiline = false,
  ) => (
    <View style={styles.field}>
      <Text style={text}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        style={input}
        value={value}
        onChangeText={onChangeText}
        maxLength={maxLength}
        editable={!busy && !paired && (!multiline || !!account?.canEditInstructions)}
        multiline={multiline}
      />
    </View>
  );
  return (
    <View style={styles.section} accessibilityLabel={t("Account")}>
      {error ? (
        <View>
          <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
            {error}
          </Text>
          <Button title={t("Retry")} onPress={() => setReload((value) => value + 1)} />
        </View>
      ) : null}
      {paired ? (
        <Text style={muted}>{t("Sign in to edit your profile and manage sessions.")}</Text>
      ) : null}
      {account ? (
        <>
          <Text accessibilityRole="header" style={[styles.heading, text]}>
            {t("Profile")}
          </Text>
          {field(t("Full name"), account.name, (name) => change({ name }), 120)}
          {field(
            t("What should your bots call you?"),
            account.displayName,
            (displayName) => change({ displayName }),
            60,
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("What best describes your work?")}
            disabled={busy || paired}
            onPress={() =>
              presentMessageActionSheet({
                title: t("What best describes your work?"),
                actions: work.map(([value, label]) => ({
                  text: label,
                  onPress: () => change({ workType: value }),
                })),
                colorScheme,
                cancel: t("Cancel"),
                more: t("More"),
              })
            }
          >
            <Text style={text}>{t("What best describes your work?")}</Text>
            <Text style={muted}>{work.find(([value]) => value === account.workType)?.[1]}</Text>
          </Pressable>
          {field(
            t("Instructions for all bots"),
            account.instructions,
            (instructions) => change({ instructions }),
            4000,
            true,
          )}
          {!paired ? (
            <Button
              title={t("Save")}
              color={tokens.primary}
              disabled={busy || !account.name.trim()}
              onPress={() =>
                void perform(async () => {
                  const profile = await rpc<AccountProfileInput>("account/updateProfile", {
                    name: account.name,
                    displayName: account.displayName,
                    workType: account.workType,
                    avatarStyle,
                  });
                  let instructionsRevision = account.instructionsRevision;
                  if (account.canEditInstructions) {
                    const result = await rpc<{ revision: number }>("account/updateInstructions", {
                      instructions: account.instructions,
                      revision: account.instructionsRevision,
                    });
                    instructionsRevision = result.revision;
                  }
                  setAccount({ ...account, ...profile, instructionsRevision });
                  setSaved(true);
                })
              }
            />
          ) : null}
          {saved ? (
            <Text accessibilityLiveRegion="polite" style={muted}>
              {t("Saved")}
            </Text>
          ) : null}
          <Text style={muted}>{t("Space ID")}</Text>
          <Text selectable style={text}>
            {account.spaceId}
          </Text>
          {!paired ? (
            <Button
              title={t("Log out of all devices")}
              onPress={() =>
                Alert.alert(
                  t("Log out of all devices"),
                  t("This signs out every other session and keeps this one signed in."),
                  [
                    { text: t("Cancel"), style: "cancel" },
                    {
                      text: t("Log out"),
                      style: "destructive",
                      onPress: () =>
                        void perform(async () => {
                          await rpc("account/revokeOtherSessions");
                          setSessions((rows) => rows.filter((row) => row.current));
                        }),
                    },
                  ],
                )
              }
              disabled={busy}
            />
          ) : null}
          <Text accessibilityRole="header" style={[styles.heading, text]}>
            {t("Require trusted devices")}
          </Text>
          <Text style={muted}>{account.requireTrustedDevices ? t("On") : t("Off")}</Text>
        </>
      ) : null}
      <Text accessibilityRole="header" style={[styles.heading, text]}>
        {t("Local devices")}
      </Text>
      {devices.map((device) => (
        <View key={`${device.kind}:${device.id}`} style={styles.field}>
          <Text style={text}>{device.name}</Text>
          <Text style={muted}>{devicePlatform(device.platform)}</Text>
          <Text style={muted}>
            {t("Added")}: {accountDate(device.createdAt, locale)}
          </Text>
          <Text style={muted}>
            {t("Last seen")}: {accountDate(device.lastSeenAt, locale)}
          </Text>
          {!device.approved ? <Text style={muted}>{t("Needs approval")}</Text> : null}
        </View>
      ))}
      {!paired ? (
        <>
          <Text accessibilityRole="header" style={[styles.heading, text]}>
            {t("Active sessions")}
          </Text>
          {sessionError ? (
            <Text style={{ color: tokens.destructive }}>
              {t("Sign in again to manage sessions.")}
            </Text>
          ) : (
            <>
              {page.rows.map((session) => (
                <View key={session.id} style={styles.field}>
                  <Text style={text}>
                    {t(session.device)}
                    {session.current ? ` · ${t("Current")}` : ""}
                  </Text>
                  <Text style={muted}>
                    {t("Created")}: {accountDate(session.createdAt, locale)}
                  </Text>
                  <Text style={muted}>
                    {t("Updated")}: {accountDate(session.updatedAt, locale)}
                  </Text>
                  <Button
                    title={t("Sign out")}
                    disabled={busy}
                    onPress={() =>
                      void perform(async () => {
                        await rpc("account/revokeSession", { id: session.id });
                        if (session.current) {
                          await signOut();
                          router.replace(explicitSignInRoute);
                        } else setSessions((rows) => rows.filter((row) => row.id !== session.id));
                      })
                    }
                  />
                </View>
              ))}
              <Text style={muted}>
                {t("Showing {start}–{end} of {total}", {
                  start: page.start,
                  end: page.end,
                  total: page.total,
                })}
              </Text>
              <View style={styles.row}>
                <Button
                  title={t("Previous")}
                  disabled={busy || page.page === 0}
                  onPress={() => setPage(page.page - 1)}
                />
                <Button
                  title={t("Next")}
                  disabled={busy || page.end >= page.total}
                  onPress={() => setPage(page.page + 1)}
                />
              </View>
            </>
          )}
        </>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  section: { gap: 16, padding: 16 },
  heading: { fontSize: 17, fontWeight: "600" },
  field: { gap: 6 },
  input: { borderWidth: 1, borderRadius: 8, padding: 12, fontSize: 16, minHeight: 44 },
  row: { flexDirection: "row", justifyContent: "space-between" },
});
