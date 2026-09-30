import type { ComputerConnectionSettings, ComputerMode, ComputerStatus } from "@ardurbot/contracts";
import {
  COMPUTER_BOUNDARY_MESSAGES,
  computerKindFacts,
  computerRuntimeSummary,
} from "@ardurbot/contracts";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

type Connection = { id: string; name: string; settings: ComputerConnectionSettings };
export function RuntimeBoundary({ kind, locationName }: { kind: string; locationName?: string }) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const facts = computerKindFacts(kind);
  if (!facts)
    return (
      <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
        {t("Computer location unavailable. Choose a supported connection.")}
      </Text>
    );

  return (
    <View style={styles.lines}>
      <Text style={{ color: tokens.foreground }}>
        {t(facts.location)}
        {locationName ? ` · ${locationName}` : ""}
      </Text>
      <Text style={{ color: tokens.mutedForeground }}>
        {t(COMPUTER_BOUNDARY_MESSAGES[facts.boundary])}
      </Text>
    </View>
  );
}
export function RuntimeSummary({
  status,
  mode = status.mode,
  locationName,
}: {
  status: ComputerStatus;
  mode?: ComputerMode;
  locationName?: string;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const facts = computerRuntimeSummary(status, mode);
  if (!facts) return <RuntimeBoundary kind={status.kind} />;
  const states = {
    stopped: "Stopped",
    booting: "Starting",
    running: "Running",
    suspended: "Sleeping",
    error: "Could not start",
  };
  return (
    <View testID="runtime-summary" style={styles.lines}>
      <RuntimeBoundary kind={status.kind} locationName={locationName} />
      <Text style={{ color: tokens.foreground }}>{t(facts.sharing)}</Text>
      {facts.sharingWarning ? (
        <Text style={{ color: tokens.mutedForeground }}>{t(facts.sharingWarning)}</Text>
      ) : null}
      <Text style={{ color: tokens.mutedForeground }}>{t(states[facts.state])}</Text>
    </View>
  );
}
export function BotRuntimeSettings({
  botId,
  mode,
  children,
}: {
  botId: string;
  mode: ComputerMode;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [data, setData] = useState<{
    status: ComputerStatus;
    connections: Connection[];
    teamStatus?: ComputerStatus;
  } | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setData((current) => (current?.status.botId === botId ? current : null));
    setError(false);
    void Promise.all([
      rpc<ComputerStatus>("computer/status", { botId }),
      rpc<Connection[]>("computer/connections", {}),
      rpc<{ status: ComputerStatus }[]>("computer/list", {}),
    ])
      .then(([status, connections, computers]) => {
        if (active)
          setData({
            status,
            connections,
            teamStatus: computers.find((entry) => entry.status.mode === "team")?.status,
          });
      })
      .catch(() => {
        if (active) setError(true);
      });
    const timer = setInterval(() => setRevision((value) => value + 1), 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [botId, mode, revision]);
  return (
    <View style={[styles.card, { borderColor: tokens.border }]}>
      <Text style={{ color: tokens.foreground, fontWeight: "600" }}>
        {t("Where this bot runs")}
      </Text>
      {data ? (
        <RuntimeSummary
          status={data.status}
          locationName={
            data.connections.find((entry) => entry.id === data.status.connectionId)?.name ??
            (data.status.kind === "desktop" ? undefined : data.status.kind)
          }
        />
      ) : null}
      {children}
      {data && mode === "team" && data.status.mode !== mode && data.teamStatus ? (
        <RuntimeBoundary
          kind={data.teamStatus.kind}
          locationName={
            data.connections.find((entry) => entry.id === data.teamStatus?.connectionId)?.name
          }
        />
      ) : null}
      {error ? (
        <>
          <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
            {t("Computer location unavailable. Try again.")}
          </Text>
          <Pressable accessibilityRole="button" onPress={() => setRevision((value) => value + 1)}>
            <Text style={{ color: tokens.foreground }}>{t("Retry")}</Text>
          </Pressable>
        </>
      ) : null}
      <Pressable
        accessibilityRole="button"
        onPress={() => Alert.alert(t("Change location"), t("Change location on desktop."))}
      >
        <Text style={{ color: tokens.foreground }}>{t("Change location")}</Text>
      </Pressable>
    </View>
  );
}
const styles = StyleSheet.create({
  card: { marginTop: 16, padding: 16, borderWidth: 1, borderRadius: 11, gap: 12 },
  lines: { gap: 8 },
});
