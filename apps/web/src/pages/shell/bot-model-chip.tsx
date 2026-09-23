import type { Bot } from "@ardurbot/contracts";
import { spaceDefaultEffort } from "@ardurbot/core";
import { Button } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { modelUnavailable, spaceDefaultUnavailable } from "../../lib/model-availability";
import type { ModelSettings } from "../../lib/use-model-settings";

export function effectiveBotModel(
  bot: Pick<Bot, "modelProvider" | "modelId" | "thinkingLevel" | "modelCredentialId">,
  { me, catalog, credentials }: ModelSettings,
) {
  const hasOverride = Boolean(
    bot.modelProvider != null || bot.modelId != null || bot.modelCredentialId != null,
  );
  const useOverride = hasOverride;
  const provider = useOverride ? bot.modelProvider : me.defaultProvider;
  const modelId = useOverride ? bot.modelId : me.defaultModel;
  if (!provider || !modelId) return null;
  const entry = catalog.find((item) => item.provider === provider && item.id === modelId);
  const credential = credentials.find((item) =>
    bot.modelCredentialId
      ? item.id === bot.modelCredentialId && item.provider === provider
      : item.provider === provider && item.modelId === modelId,
  );
  const levels = credential?.thinkingLevels ?? entry?.thinkingLevels;
  const reasoning = credential?.reasoning ?? entry?.reasoning;
  const thinkingLevel =
    bot.thinkingLevel ??
    (useOverride
      ? undefined
      : (credential?.thinkingLevel ?? spaceDefaultEffort(reasoning, levels)));
  return {
    label: entry?.label ?? modelId,
    providerLabel: provider === "openai-codex" ? "Codex" : (entry?.providerName ?? provider),
    thinkingLevel,
    isDefault: !useOverride,
    unavailable: useOverride
      ? Boolean(
          (bot.modelCredentialId && !credential) ||
            (thinkingLevel && levels && !levels.includes(thinkingLevel)) ||
            modelUnavailable({ catalog, credentials }, provider, modelId),
        )
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
