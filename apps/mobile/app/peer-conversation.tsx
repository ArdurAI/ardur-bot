import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { Text, View } from "react-native";
import { PeerConversation } from "../components/peer-conversation";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

export default function PeerConversationRoute() {
  const { botId, botName, groupId, peerBotId, peerName } = useLocalSearchParams<{
    botId?: string;
    botName?: string;
    groupId?: string;
    peerBotId?: string;
    peerName?: string;
  }>();
  const router = useRouter();
  const { t } = useI18n();
  const tokens = useMobileTokens();
  return (
    <View style={{ flex: 1, backgroundColor: tokens.background }}>
      <Stack.Screen options={{ title: t("Conversation") }} />
      {peerBotId && (groupId || botId) ? (
        <PeerConversation
          botId={botId}
          groupId={groupId}
          peerBotId={peerBotId}
          peerName={peerName ?? t("Bot")}
          botName={botName ?? t("Bot")}
          onOpenPeer={(id) => router.push({ pathname: "/thread", params: { botId: id } })}
        />
      ) : (
        <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
          {t("Could not load this chat.")}
        </Text>
      )}
    </View>
  );
}
