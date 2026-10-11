import type { EvidenceKeyHistory, EvidenceRunSummary } from "@ardurbot/contracts/evidence";
import {
  EVIDENCE_SIGNER_LABELS,
  EvidenceFingerprintSchema,
  EvidenceKeyHistorySchema,
  EvidenceRunSummarySchema,
} from "@ardurbot/contracts/evidence";
import type { ComponentProps } from "react";
import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Modal,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
} from "react-native";
import { captureApiRequestContext, rpc, selectedSpaceId } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { dispatchClient } from "../lib/dispatch";
import { mobileEvidencePresentation } from "../lib/evidence";
import { exportEvidenceIdentity, exportRunEvidence } from "../lib/evidence-export";
import { useI18n } from "../lib/i18n";
import { native } from "../lib/native";
import { NativeSymbol } from "./native-symbol";

const EVIDENCE_KEY_STATE_LABELS = {
  active: "Active",
  replaced: "Replaced",
  revoked: "Revoked",
} as const;

const icons = {
  circle: { ios: "circle", android: "ellipse-outline" },
  loader: { ios: "clock", android: "time-outline" },
  shield: { ios: "shield", android: "shield-outline" },
  "shield-check": { ios: "checkmark.shield", android: "shield-checkmark-outline" },
  "shield-alert": { ios: "exclamationmark.shield", android: "warning-outline" },
  "shield-x": { ios: "xmark.shield", android: "close-circle-outline" },
} satisfies Record<string, Pick<ComponentProps<typeof NativeSymbol>, "ios" | "android">>;

export function RunEvidence({
  runId,
  live,
}: {
  runId: string;
  live: boolean;
  colorScheme: "light" | "dark";
}) {
  const { t } = useI18n();
  const tokens = mobileTokens();
  const spaceId = selectedSpaceId();
  const [result, setResult] = useState<{
    runId: string;
    spaceId: string | null;
    summary: EvidenceRunSummary;
    paired: boolean;
  } | null>(null);
  const [sharing, setSharing] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retries = 0;
    async function load() {
      try {
        const requestContext = await captureApiRequestContext();
        if (controller.signal.aborted || spaceId !== selectedSpaceId()) return;
        const summary = await rpc<EvidenceRunSummary>(
          "evidence/runSummary",
          { runId },
          { signal: controller.signal, requestContext },
        );
        if (controller.signal.aborted) return;
        const parsed = EvidenceRunSummarySchema.safeParse(summary);
        if (!parsed.success) {
          setResult(null);
          return;
        }
        const paired = Boolean(await dispatchClient.loadHome());
        if (controller.signal.aborted) return;
        setResult({ runId, spaceId, summary: parsed.data, paired });
        if (
          live ||
          summary.state === "recording" ||
          (summary.state === "unsealed" && retries++ < 12)
        )
          timer = setTimeout(() => void load(), 5_000);
      } catch {
        if (!controller.signal.aborted) setResult(null);
      }
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [runId, spaceId, live]);
  const summary = result?.runId === runId && result.spaceId === spaceId ? result.summary : null;
  const presentation = summary && mobileEvidencePresentation(summary);
  if (!presentation) return null;
  async function share() {
    setSharing(true);
    try {
      await exportRunEvidence(runId);
    } catch {
      Alert.alert(t("The export could not finish; try again."));
    } finally {
      setSharing(false);
    }
  }
  const content = (
    <>
      <NativeSymbol {...icons[presentation.icon]} size={13} color={tokens.mutedForeground} />
      <Text style={{ color: tokens.mutedForeground, fontSize: 12 }}>{presentation.label}</Text>
    </>
  );
  const details = presentation.detail || undefined;
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[presentation.label, details].filter(Boolean).join(". ")}
        style={styles.action}
        onPress={() => setDetailsOpen(true)}
      >
        {content}
      </Pressable>
      <Modal
        visible={detailsOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setDetailsOpen(false)}
      >
        <ScrollView
          style={{ backgroundColor: native.page }}
          contentContainerStyle={{ padding: 24, gap: 16 }}
          keyboardShouldPersistTaps="handled"
        >
          <Button title={t("Close")} onPress={() => setDetailsOpen(false)} />
          {details && <Text style={{ color: native.label }}>{details}</Text>}
          {summary && (
            <EvidenceIdentityDetails
              key={`${runId}:${spaceId}`}
              summary={summary}
              spaceId={spaceId}
              open={detailsOpen}
              paired={Boolean(result?.paired)}
            />
          )}
          {presentation.downloadable && !result?.paired && (
            <Button
              title={t("Download evidence")}
              disabled={sharing}
              onPress={() => void share()}
            />
          )}
        </ScrollView>
      </Modal>
    </>
  );
}

export function EvidenceIdentityDetails({
  summary,
  spaceId,
  open,
  paired,
}: {
  summary: EvidenceRunSummary;
  spaceId: string | null;
  open: boolean;
  paired: boolean;
}) {
  const { t } = useI18n();
  const [history, setHistory] = useState<EvidenceKeyHistory | null>(null);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const [reason, setReason] = useState("");
  const [expected, setExpected] = useState("");
  const [checked, setChecked] = useState<{
    expected: string;
    match: EvidenceRunSummary["signerMatch"];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  useEffect(
    () => () => {
      request.current++;
    },
    [],
  );
  useEffect(() => {
    if (!open) return;
    let stale = false;
    (async () => {
      try {
        const reply = await rpc<EvidenceKeyHistory>(
          "evidence/keyHistory",
          {},
          { requestContext: await captureApiRequestContext() },
        );
        if (!stale) setHistory(EvidenceKeyHistorySchema.parse(reply));
      } catch {
        // The identity card stays usable without history.
      }
    })();
    return () => {
      stale = true;
    };
  }, [open]);
  const identity = summary.signingIdentity;
  const activeEntry = history?.keys.find((entry) => entry.state === "active") ?? null;
  const scopeId = identity?.scope.id ?? spaceId;
  const shownIdentity = history
    ? activeEntry && scopeId
      ? {
          fingerprint: activeEntry.keyId,
          scope: { type: "space" as const, id: scopeId },
          keyVersion: activeEntry.version,
        }
      : null
    : identity;
  const activeFingerprint = activeEntry?.keyId ?? shownIdentity?.fingerprint ?? "";
  const fingerprint = expected.trim();
  const valid = !fingerprint || EvidenceFingerprintSchema.safeParse(fingerprint).success;
  const match = summary.sealed
    ? checked?.expected === fingerprint
      ? checked.match
      : !fingerprint
        ? summary.signerMatch
        : null
    : null;
  async function check() {
    const id = ++request.current;
    setBusy(true);
    setChecked(null);
    try {
      const requestContext = await captureApiRequestContext();
      if (spaceId !== selectedSpaceId() || id !== request.current) return;
      const reply = await rpc<EvidenceRunSummary>(
        "evidence/runSummary",
        {
          runId: summary.sessionId,
          ...(fingerprint ? { expectedFingerprint: fingerprint } : {}),
        },
        { requestContext },
      );
      if (spaceId !== selectedSpaceId() || id !== request.current) return;
      const parsed = EvidenceRunSummarySchema.parse(reply);
      setChecked({ expected: fingerprint, match: parsed.signerMatch });
      if (!parsed.signerMatch) Alert.alert(t("Check failed"));
    } catch {
      if (id === request.current) {
        setChecked({ expected: fingerprint, match: null });
        Alert.alert(t("Check failed"));
      }
    } finally {
      if (id === request.current) setBusy(false);
    }
  }
  async function shareIdentity(card: boolean) {
    if (!shownIdentity) return;
    try {
      if (card) await exportEvidenceIdentity(shownIdentity);
      else await Share.share({ message: shownIdentity.fingerprint });
    } catch {
      Alert.alert(t("The export could not finish; try again."));
    }
  }
  async function reloadHistory(): Promise<void> {
    const reply = await rpc<EvidenceKeyHistory>(
      "evidence/keyHistory",
      {},
      { requestContext: await captureApiRequestContext() },
    );
    setHistory(EvidenceKeyHistorySchema.parse(reply));
  }
  async function manage(action: "replaceKey" | "revokeKey") {
    if (!activeFingerprint) return;
    try {
      const reply = await rpc<EvidenceKeyHistory>(
        `evidence/${action}`,
        action === "revokeKey"
          ? { expectedFingerprint: activeFingerprint, reason: reason.trim() }
          : { expectedFingerprint: activeFingerprint },
        { requestContext: await captureApiRequestContext() },
      );
      setHistory(EvidenceKeyHistorySchema.parse(reply));
      setConfirmingRevoke(false);
      setReason("");
    } catch {
      try {
        await reloadHistory();
      } catch {
        /* Keep the previous history. */
      }
      Alert.alert(t("The key changed. Reload and try again."));
    }
  }
  function confirmReplace() {
    Alert.alert(
      t("Replace key?"),
      t("Runs already admitted keep their key; new runs sign with the new key."),
      [
        { text: t("Cancel"), style: "cancel" },
        { text: t("Replace key"), onPress: () => void manage("replaceKey") },
      ],
    );
  }
  return (
    <>
      {shownIdentity && (
        <>
          <Text style={{ color: native.label }}>{t("Signing identity")}</Text>
          <Text selectable style={{ color: native.label }}>
            {t("Fingerprint")}
            {"\n"}
            {shownIdentity.fingerprint}
          </Text>
          <Text style={{ color: native.label }}>
            {t("Space")}: {shownIdentity.scope.id}
          </Text>
          <Text style={{ color: native.label }}>
            {t("Key version")}: {shownIdentity.keyVersion}
          </Text>
          <Button title={t("Share fingerprint")} onPress={() => void shareIdentity(false)} />
          <Button title={t("Export identity card")} onPress={() => void shareIdentity(true)} />
        </>
      )}
      {history && history.keys.length > 0 && (
        <>
          <Text style={{ color: native.label }}>{t("Key history")}</Text>
          {history.keys.map((entry) => (
            <Text key={entry.keyId} style={{ color: native.secondaryLabel }}>
              {t("Version {version}", { version: entry.version })} ·{" "}
              {t(EVIDENCE_KEY_STATE_LABELS[entry.state])}
              {entry.replacedAt
                ? ` · ${t("Replaced")} ${new Date(entry.replacedAt).toLocaleString()}`
                : ""}
              {entry.revokedAt && !entry.replacedAt
                ? ` · ${t("Revoked")} ${new Date(entry.revokedAt).toLocaleString()}${entry.revokedReason ? ` (${entry.revokedReason})` : ""}`
                : ""}
            </Text>
          ))}
        </>
      )}
      {history?.canManage && !paired && !confirmingRevoke && (
        <>
          <Button title={t("Replace key")} onPress={confirmReplace} />
          <Button title={t("Revoke key")} onPress={() => setConfirmingRevoke(true)} />
        </>
      )}
      {history?.canManage && !paired && confirmingRevoke && (
        <>
          <Text style={{ color: native.label }}>
            {t(
              "Revoke the signing key? Signing stops at once. Records signed before revocation still verify.",
            )}
          </Text>
          <TextInput
            accessibilityLabel={t("Reason")}
            placeholder={t("Reason")}
            value={reason}
            onChangeText={setReason}
            maxLength={200}
            autoCapitalize="none"
            style={{ padding: 12, color: native.label, backgroundColor: native.fill }}
          />
          <Button
            title={t("Revoke key")}
            disabled={!reason.trim()}
            onPress={() => void manage("revokeKey")}
          />
          <Button title={t("Cancel")} onPress={() => setConfirmingRevoke(false)} />
        </>
      )}
      <TextInput
        accessibilityLabel={t("Expected fingerprint")}
        placeholder={t("Expected fingerprint")}
        value={expected}
        onChangeText={setExpected}
        maxLength={80}
        autoCapitalize="none"
        autoCorrect={false}
        style={{ padding: 12, color: native.label, backgroundColor: native.fill }}
      />
      <Button title={t("Check key")} disabled={!valid || busy} onPress={() => void check()} />
      {match && (
        <Text accessibilityRole="alert" style={{ color: native.label }}>
          {t(EVIDENCE_SIGNER_LABELS[match])}
        </Text>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  action: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    minHeight: 44,
    alignSelf: "flex-start",
  },
});
