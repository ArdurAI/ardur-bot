import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

/** Exact, selectable approval contents. Collapsing never discards the payload. */
export function ApprovalPreview({ text, detail }: { text: string; detail?: string }) {
  const [expanded, setExpanded] = useState(true);
  const { t } = useI18n();
  const tokens = useMobileTokens();
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
      >
        <Text style={{ color: tokens.foreground, fontSize: 14 }}>{t("Details")}</Text>
      </Pressable>
      {expanded ? (
        <Text
          selectable
          style={{
            color: tokens.foreground,
            marginTop: 8,
            fontSize: 12.5,
            fontFamily: "Menlo",
            lineHeight: 20,
            writingDirection: "ltr",
          }}
        >
          {[text, detail].filter(Boolean).join("\n")}
        </Text>
      ) : null}
    </View>
  );
}
