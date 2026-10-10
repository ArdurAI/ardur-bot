import { StyleSheet, Text } from "react-native";
import { useI18n } from "../lib/i18n";

export function ComposerRecipients({
  names,
  queued,
  color,
}: {
  names: readonly string[];
  queued: readonly string[];
  color: string;
}) {
  const { t } = useI18n();
  return (
    <>
      {names.length ? (
        <Text
          testID="composer-recipients"
          accessibilityLabel={t("To {names}", { names: names.join(", ") })}
          accessibilityLiveRegion="polite"
          numberOfLines={1}
          style={[styles.line, { color }]}
        >
          {t("To {names}", { names: names.join(", ") })}
        </Text>
      ) : null}
      {queued.length ? (
        <Text
          testID="composer-queued"
          accessibilityLabel={t("Queued: {queued}", { queued: queued.join(", ") })}
          accessibilityLiveRegion="polite"
          numberOfLines={1}
          style={[styles.line, { color }]}
        >
          {t("Queued: {queued}", { queued: queued.join(", ") })}
        </Text>
      ) : null}
    </>
  );
}
const styles = StyleSheet.create({ line: { fontSize: 12, marginTop: 8 } });
