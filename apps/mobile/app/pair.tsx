import type { PairingPayload } from "@ardurbot/contracts";
import { homeSignedText, PairingPayloadSchema } from "@ardurbot/contracts";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Button, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { saveApiBase, selectSpace } from "../lib/api";
import { dispatchClient, nativeDevices } from "../lib/dispatch";
import type { PairedHome } from "../lib/dispatch-client";
import { HOME_CHANGED, HOME_UNREACHABLE } from "../lib/dispatch-client";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { clearSessionToken } from "../lib/session";

export default function PairDevice() {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const router = useRouter();
  const [payload, setPayload] = useState<PairingPayload | null>(null);
  const [url, setUrl] = useState("");
  const [code, setCode] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    fingerprint: string;
    poll: () => Promise<PairedHome | null>;
  } | null>(null);
  function acceptQr(raw: string) {
    const parsed = PairingPayloadSchema.parse(JSON.parse(raw));
    setPayload(parsed);
    setUrl(parsed.hints[0] ?? "");
    setPin(parsed.certificateFingerprint);
    setError(null);
  }
  async function finish(home: PairedHome) {
    if (!(await clearSessionToken())) {
      await dispatchClient.unpair();
      throw new Error(t("The previous session could not be cleared; try again."));
    }
    const saved = await saveApiBase(home.url);
    if (!saved.ok || !(await selectSpace(home.spaceId)))
      throw new Error(t("This home could not be saved; try again."));
    router.replace("/");
  }
  useEffect(() => {
    if (!pending) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const home = await pending.poll();
        if (active && home) {
          await finish(home);
          return;
        }
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : HOME_UNREACHABLE);
      }
      if (active) timer = setTimeout(() => void poll(), 2_000);
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [pending]);
  async function pair() {
    setBusy(true);
    setError(null);
    try {
      let target = payload;
      if (!target) {
        const parsed = new URL(url);
        if (
          parsed.protocol !== "https:" ||
          parsed.username ||
          parsed.password ||
          parsed.pathname !== "/"
        )
          throw new Error(t("Enter your HTTPS home address."));
        if (!/^[a-f0-9]{64}$/.test(pin))
          throw new Error(t("Copy the certificate fingerprint from Devices at home."));
        const clientChallenge = nativeDevices.nonce();
        const response = await nativeDevices.request(
          `${parsed.origin}/device/nonce`,
          pin,
          JSON.stringify({ clientChallenge }),
        );
        const identity = JSON.parse(response.body);
        if (
          response.status !== 200 ||
          !(await nativeDevices.verifyHome(
            identity.certificate,
            pin,
            homeSignedText(identity.instanceId, identity.fingerprint, clientChallenge),
            identity.signature,
          ))
        )
          throw new Error(HOME_CHANGED);
        target = PairingPayloadSchema.parse({
          version: 1,
          challenge: "short-code-confirmation-required-at-home",
          hints: [parsed.origin],
          instanceId: identity.instanceId,
          homeName: identity.homeName,
          fingerprint: identity.fingerprint,
          certificateFingerprint: pin,
        });
        setPayload(target);
      }
      const result = await dispatchClient.pair(target, url, code || undefined);
      if (result.home) await finish(result.home);
      else if (result.poll && result.fingerprint)
        setPending({ poll: result.poll, fingerprint: result.fingerprint });
    } catch (e) {
      setError(e instanceof Error ? e.message : HOME_UNREACHABLE);
    } finally {
      setBusy(false);
    }
  }
  return (
    <SafeAreaView style={[styles.page, { backgroundColor: tokens.background }]}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={[styles.title, { color: tokens.foreground }]}>{t("Pair device")}</Text>
        {error ? (
          <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
            {error}
          </Text>
        ) : null}
        <Button
          title={t("Scan QR code")}
          disabled={busy || Boolean(pending)}
          onPress={() =>
            void nativeDevices
              .scanQr()
              .then(acceptQr)
              .catch(() => setError(t("Scan the pairing code again.")))
          }
        />
        {payload ? (
          <View style={styles.content}>
            <Text style={{ color: tokens.foreground }}>{payload.homeName}</Text>
            <Text selectable style={{ color: tokens.mutedForeground }}>
              {payload.fingerprint}
            </Text>
            {payload.hints.map((hint) => (
              <Button key={hint} title={hint} onPress={() => setUrl(hint)} />
            ))}
          </View>
        ) : null}
        <TextInput
          accessibilityLabel={t("Home address")}
          placeholder={t("Home address")}
          placeholderTextColor={tokens.mutedForeground}
          value={url}
          onChangeText={setUrl}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.input, { color: tokens.foreground, borderColor: tokens.border }]}
        />
        {!payload ? (
          <TextInput
            accessibilityLabel={t("Certificate fingerprint")}
            placeholder={t("Certificate fingerprint")}
            placeholderTextColor={tokens.mutedForeground}
            value={pin}
            onChangeText={setPin}
            autoCapitalize="none"
            autoCorrect={false}
            style={[styles.input, { color: tokens.foreground, borderColor: tokens.border }]}
          />
        ) : null}
        <TextInput
          accessibilityLabel={t("Pairing code")}
          placeholder={t("Pairing code")}
          placeholderTextColor={tokens.mutedForeground}
          value={code}
          onChangeText={setCode}
          maxLength={8}
          autoCapitalize="characters"
          autoCorrect={false}
          style={[styles.input, { color: tokens.foreground, borderColor: tokens.border }]}
        />
        {busy || pending ? (
          <Text style={{ color: tokens.foreground }}>{t("Waiting for home")}</Text>
        ) : null}
        {pending ? (
          <>
            <Text style={{ color: tokens.foreground }}>
              {t("Confirm this phone fingerprint in Devices at home.")}
            </Text>
            <Text selectable style={{ color: tokens.mutedForeground }}>
              {pending.fingerprint}
            </Text>
          </>
        ) : null}
        <Button
          title={t("Pair")}
          disabled={busy || Boolean(pending) || !url || (!payload && code.length !== 8)}
          onPress={() => void pair()}
        />
        <Button title={t("Cancel")} onPress={() => router.back()} />
      </ScrollView>
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  page: { flex: 1 },
  content: { padding: 20, gap: 16 },
  title: { fontSize: 24, fontWeight: "600" },
  input: { minHeight: 48, borderWidth: 1, borderRadius: 10, padding: 12 },
});
