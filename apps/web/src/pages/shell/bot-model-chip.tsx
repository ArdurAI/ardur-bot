import type { Bot } from "@ardurbot/contracts";
import { ThinkingLevelSchema } from "@ardurbot/contracts";
import { Button } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { modelUnavailable, spaceDefaultUnavailable } from "../../lib/model-availability";
import type { ModelSettings } from "../../lib/use-model-settings";

export function effectiveBotModel(
  bot: Pick<Bot, "modelProvider" | "modelId" | "thinkingLevel">,
  { me, catalog, credentials }: ModelSettings,
) {
  const hasOverride = Boolean(bot.modelProvider && bot.modelId);
  const useOverride = hasOverride;
  const provider = useOverride ? bot.modelProvider : me.defaultProvider;
  const modelId = useOverride ? bot.modelId : me.defaultModel;
  if (!provider || !modelId) return null;
  const entry = catalog.find((item) => item.provider === provider && item.id === modelId);
  const credential = credentials.find(
    (item) => item.provider === provider && item.modelId === modelId,
  );
  const levels = credential?.thinkingLevels ?? entry?.thinkingLevels;
  const reasoning = credential?.reasoning ?? entry?.reasoning;
  const preferred = bot.thinkingLevel ?? credential?.thinkingLevel ?? "medium";
  // Match the runtime's nearest supported level, preferring a higher level first.
  const orderedLevels = ThinkingLevelSchema.options;
  const index = orderedLevels.indexOf(preferred);
  const thinkingLevel =
    reasoning === false
      ? "off"
      : levels
        ? [...orderedLevels.slice(index), ...orderedLevels.slice(0, index).reverse()].find(
            (level) => levels.includes(level),
          )
        : undefined;
  return {
    label: entry?.label ?? modelId,
    providerLabel: provider === "openai-codex" ? "Codex" : (entry?.providerName ?? provider),
    thinkingLevel,
    isDefault: !useOverride,
    unavailable: useOverride
      ? modelUnavailable({ catalog, credentials }, provider, modelId)
      : spaceDefaultUnavailable({ me, catalog, credentials }),
  };
}

export function BotModelChip({
  bot,
  settings,
  onClick,
}: {
  bot: Bot;
  settings: ModelSettings | null;
  onClick: () => void;
}) {
  const { t } = useLingui();
  const model = settings ? effectiveBotModel(bot, settings) : null;
  if (!model) return null;
  const label = `${model.providerLabel} · ${model.label}${model.thinkingLevel ? ` · ${model.thinkingLevel}` : ""}${model.unavailable ? t` · not available` : ""}`;
  return (
    <Button
      variant="ghost"
      size="xs"
      className={`app-no-drag min-w-0 shrink font-normal ${model.unavailable ? "text-warning" : "text-muted-foreground"}`}
      aria-label={t`Change model: ${label}`}
      onClick={onClick}
    >
      <span className="truncate">{label}</span>
      {model.isDefault ? (
        <span className="text-muted-foreground/70">
          <Trans>default</Trans>
        </span>
      ) : null}
    </Button>
  );
}
