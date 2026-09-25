import type { RuntimeInfo, RuntimePin } from "@ardurbot/contracts";
import { runtimeNames } from "@ardurbot/contracts";
import { botEffortLabel } from "@ardurbot/core";
import { Text } from "react-native";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

export function BotRuntimeLabel({
  bot,
  run,
}: {
  bot: Parameters<typeof botEffortLabel>[0];
  run?: { runtimePin?: RuntimePin | null; runtimeInfo?: RuntimeInfo | null } | null;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const effort =
    bot.runtimeKind === "claude-code" ? botEffortLabel(bot, run, t("requested")) : null;
  return (
    <Text numberOfLines={1} style={{ color: tokens.mutedForeground, fontSize: 12 }}>
      {runtimeNames[bot.runtimeKind ?? "pi"]}
      {effort ? ` · ${effort}` : ""}
    </Text>
  );
}
