import { useEffect, useState, useSyncExternalStore } from "react";
import { Button, Text, View } from "react-native";
import {
  dispatchClient,
  dispatchStatus,
  hasPairedDevice,
  subscribeDispatchStatus,
} from "../lib/dispatch";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

export function DispatchStatus() {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const status = useSyncExternalStore(subscribeDispatchStatus, dispatchStatus, dispatchStatus);
  const [paired, setPaired] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void hasPairedDevice().then(setPaired);
    void dispatchClient.pending().then((p) => setWaiting(Boolean(p)));
  }, [status]);
  if (!paired || (!status && !waiting)) return null;
  return (
    <View>
      <Text accessibilityLiveRegion="polite" style={{ color: tokens.mutedForeground }}>
        {waiting ? t("Waiting for home") : status ? t(status) : null}
      </Text>
      {error ? (
        <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
          {error}
        </Text>
      ) : null}
      {waiting ? (
        <View style={{ flexDirection: "row" }}>
          <Button
            title={t("Retry")}
            onPress={() =>
              void dispatchClient
                .retry()
                .catch((e) => setError(e instanceof Error ? e.message : t("Home is unreachable.")))
            }
          />
          <Button
            title={t("Discard")}
            onPress={() => void dispatchClient.discard().then(() => setWaiting(false))}
          />
        </View>
      ) : null}
    </View>
  );
}
