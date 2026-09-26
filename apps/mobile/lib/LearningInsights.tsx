import type { LearningInsight, SpaceLearningConfig } from "@ardurbot/contracts";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Alert, Button, Text, View } from "react-native";
import { useI18n } from "./i18n";
import { enableLearningReview } from "./learning";
import {
  actOnLearningInsight,
  allowLearningInsightTool,
  dismissLearningInsight,
  insightDetails,
  insightSentence,
  mobileInsightAction,
} from "./learning-insights";

type Styles = {
  card: object;
  title: object;
  secondary: object;
  body: object;
  actions: object;
};

/** The same list as web's Learning page. Nothing renders when there is nothing to say. */
export function LearningInsights({
  insights,
  settings,
  busy,
  change,
  styles,
}: {
  insights: LearningInsight[];
  settings: SpaceLearningConfig | null;
  busy: boolean;
  change: (action: () => Promise<unknown>) => Promise<void>;
  styles: Styles;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(null);
  if (!insights.length) return null;
  function act(insight: LearningInsight) {
    const offered = mobileInsightAction(insight, t);
    if (!offered) return;
    const { action } = offered;
    if (action.kind === "approval-rule") {
      const bot = insight.evidence.kind === "approval" ? insight.evidence.botName : "";
      Alert.alert(
        t("Allow {tool} for {bot} without asking?", { tool: action.tool, bot }),
        undefined,
        [
          { text: t("Cancel"), style: "cancel" },
          {
            text: t("Allow"),
            onPress: () => void change(() => allowLearningInsightTool(insight.id)),
          },
        ],
      );
      return;
    }
    void change(async () => {
      await actOnLearningInsight(insight.id);
      if (action.kind === "bot-model")
        router.push({ pathname: "/bot-settings", params: { botId: action.botId, focus: "model" } });
      else if (action.kind === "connection")
        router.push({ pathname: "/models", params: { provider: action.provider } });
      // The destination is shown on this screen before Learning is enabled.
      else if (action.kind === "learning-settings" && settings?.canConfigure)
        await enableLearningReview(settings);
    });
  }
  return (
    <View>
      <Text style={styles.title}>{t("Insights")}</Text>
      {insights.map((insight) => {
        const offered = mobileInsightAction(insight, t);
        return (
          <View key={insight.id} style={styles.card} testID="learning-insight">
            <Text style={styles.body}>{insightSentence(insight.evidence, t)}</Text>
            <View style={styles.actions}>
              {offered ? (
                <Button title={offered.label} disabled={busy} onPress={() => act(insight)} />
              ) : null}
              <Button
                title={t("Dismiss")}
                disabled={busy}
                onPress={() => void change(() => dismissLearningInsight(insight.id))}
              />
              <Button
                title={t("Details")}
                onPress={() => setOpen(open === insight.id ? null : insight.id)}
              />
            </View>
            {open === insight.id
              ? insightDetails(insight.evidence, t).map((line) => (
                  <Text key={line} selectable style={styles.secondary}>
                    {line}
                  </Text>
                ))
              : null}
          </View>
        );
      })}
    </View>
  );
}
