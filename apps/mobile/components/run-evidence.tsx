import type { EvidenceRunSummary } from "@ardurbot/contracts/evidence";
import type { ComponentProps } from "react";
import { useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { captureApiRequestContext, rpc, selectedSpaceId } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { dispatchClient } from "../lib/dispatch";
import { mobileEvidencePresentation } from "../lib/evidence";
import { exportRunEvidence } from "../lib/evidence-export";
import { useI18n } from "../lib/i18n";
import { presentMessageActionSheet } from "../lib/message-action-sheet";
import { NativeSymbol } from "./native-symbol";

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
  colorScheme,
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
        const paired = Boolean(await dispatchClient.loadHome());
        if (controller.signal.aborted) return;
        setResult({ runId, spaceId, summary, paired });
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
  return presentation.downloadable && !result?.paired ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[presentation.label, details, t("Download evidence")]
        .filter(Boolean)
        .join(". ")}
      accessibilityState={{ disabled: sharing }}
      disabled={sharing}
      style={styles.action}
      onPress={() =>
        presentMessageActionSheet({
          actions: [{ text: t("Download evidence"), onPress: () => void share() }],
          title: [presentation.label, details].filter(Boolean).join(" · "),
          cancel: t("Cancel"),
          more: t("More"),
          colorScheme,
        })
      }
    >
      {content}
    </Pressable>
  ) : (
    <View
      accessibilityLabel={[presentation.label, details].filter(Boolean).join(". ")}
      style={styles.status}
    >
      {content}
    </View>
  );
}

const styles = StyleSheet.create({
  status: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4 },
  action: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    minHeight: 44,
    alignSelf: "flex-start",
  },
});
