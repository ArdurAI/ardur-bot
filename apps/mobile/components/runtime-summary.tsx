import type {
  ComputerConnectionSettings,
  ComputerMode,
  ComputerStatus,
  ComputerUpdate,
} from "@ardurbot/contracts";
import {
  COMPUTER_BOUNDARY_MESSAGES,
  computerExecutionKind,
  computerKindFacts,
  computerRuntimeSummary,
  interruptedComputerUpdate,
} from "@ardurbot/contracts";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { rpc } from "../lib/api";
import { computerUpdates } from "../lib/computer-updates";
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
  sharingControl,
  connectionSettings,
}: {
  status: ComputerStatus;
  mode?: ComputerMode;
  locationName?: string;
  sharingControl?: ReactNode;
  connectionSettings?: Pick<ComputerConnectionSettings, "engine">;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const kind = computerExecutionKind({ ...status, connectionSettings });
  const facts = kind ? computerRuntimeSummary({ ...status, kind }, mode) : null;
  if (!facts) return <RuntimeBoundary kind="" />;

  return (
    <View testID="runtime-summary" style={styles.lines}>
      <RuntimeBoundary kind={kind!} locationName={locationName} />
      {sharingControl ?? <Text style={{ color: tokens.foreground }}>{t(facts.sharing)}</Text>}
      {facts.sharingWarning ? (
        <Text style={{ color: tokens.mutedForeground }}>{t(facts.sharingWarning)}</Text>
      ) : null}
      <Text style={{ color: tokens.mutedForeground }}>{t(facts.stateLabel)}</Text>
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
    updates: ComputerUpdate[];
  } | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [releasing, setReleasing] = useState(false);
  const [releaseError, setReleaseError] = useState(false);
  useEffect(() => {
    let active = true;
    setData((current) => (current?.status.botId === botId ? current : null));
    setError(false);
    void Promise.all([
      rpc<ComputerStatus>("computer/status", { botId }),
      rpc<Connection[]>("computer/connections", {}),
      rpc<ComputerUpdate[]>("computer/updates"),
    ])
      .then(([status, connections, updates]) => {
        if (active)
          setData({
            status,
            connections,
            updates,
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
  const interrupted = data ? interruptedComputerUpdate(data.status, data.updates) : undefined;
  return (
    <View style={[styles.card, { borderColor: tokens.border }]}>
      <Text style={{ color: tokens.foreground, fontWeight: "600" }}>
        {t("Where this bot runs")}
      </Text>
      {data ? (
        <RuntimeSummary
          status={data.status}
          mode={mode}
          sharingControl={children}
          locationName={
            data.connections.find((entry) => entry.id === data.status.connectionId)?.name
          }
          connectionSettings={
            data.connections.find((entry) => entry.id === data.status.connectionId)?.settings
          }
        />
      ) : null}

      {interrupted ? (
        <>
          <Text accessibilityRole="alert" style={{ color: tokens.mutedForeground }}>
            {t("The last update was interrupted.")}
          </Text>
          {interrupted.canReleaseReservation ? (
            <Pressable
              accessibilityRole="button"
              disabled={releasing}
              onPress={() =>
                Alert.alert(
                  t("Release interrupted computer?"),
                  t("Make sure nothing is still running on this computer."),
                  [
                    { text: t("Cancel"), style: "cancel" },
                    {
                      text: t("Nothing is still running"),
                      onPress: () => {
                        setReleasing(true);
                        setReleaseError(false);
                        void computerUpdates
                          .releaseInterrupted(interrupted.id)
                          .then(() => setRevision((value) => value + 1))
                          .catch(() => setReleaseError(true))
                          .finally(() => setReleasing(false));
                      },
                    },
                  ],
                )
              }
            >
              <Text style={{ color: tokens.foreground }}>{t("Release computer")}</Text>
            </Pressable>
          ) : null}
        </>
      ) : null}
      {releaseError ? (
        <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
          {t("Could not complete action")}
        </Text>
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
