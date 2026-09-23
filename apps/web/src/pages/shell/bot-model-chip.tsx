import type { Bot, Me, ModelCatalogEntry, ModelCredential } from "@ardurbot/contracts";
import { ThinkingLevelSchema } from "@ardurbot/contracts";
import { Button } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { rpc } from "../../lib/rpc";

type ModelSettings = {
  me: Pick<Me, "defaultProvider" | "defaultModel">;
  catalog: ModelCatalogEntry[];
  credentials: ModelCredential[];
};

export function effectiveBotModel(
  bot: Pick<Bot, "modelProvider" | "modelId" | "thinkingLevel">,
  { me, catalog, credentials }: ModelSettings,
) {
  const hasOverride = Boolean(bot.modelProvider && bot.modelId);
  const useOverride =
    hasOverride && credentials.some((entry) => entry.provider === bot.modelProvider);
  const provider = useOverride ? bot.modelProvider : me.defaultProvider;
  const modelId = useOverride ? bot.modelId : me.defaultModel;
  if (!provider || !modelId) return null;
  const entry = catalog.find((item) => item.provider === provider && item.id === modelId);
  const credential = credentials.find(
    (item) => item.provider === provider && item.modelId === modelId,
  );
  const levels = credential?.thinkingLevels ?? entry?.thinkingLevels;
  const reasoning = credential?.reasoning ?? entry?.reasoning;
  const preferred =
    (hasOverride && !useOverride ? null : bot.thinkingLevel) ??
    credential?.thinkingLevel ??
    "medium";
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
  return { label: entry?.label ?? modelId, thinkingLevel, isDefault: !useOverride };
}

export function BotModelChip({
  bot,
  spaceId,
  settingsOpen,
  onClick,
}: {
  bot: Bot;
  spaceId?: string;
  settingsOpen: boolean;
  onClick: () => void;
}) {
  const { t } = useLingui();
  const [settings, setSettings] = useState<ModelSettings | null>(null);
  useEffect(() => {
    if (settingsOpen) return;
    let cancelled = false;
    void Promise.all([rpc.me(), rpc.models.list(), rpc.models.credentials()])
      .then(([me, catalog, credentials]) => {
        if (!cancelled) setSettings({ me, catalog, credentials });
      })
      .catch(() => {
        if (!cancelled) setSettings(null);
      });
    return () => {
      cancelled = true;
    };
  }, [spaceId, settingsOpen]);
  const model = settings ? effectiveBotModel(bot, settings) : null;
  if (!model) return null;
  const label = model.thinkingLevel ? `${model.label} · ${model.thinkingLevel}` : model.label;
  return (
    <Button
      variant="ghost"
      size="xs"
      className="app-no-drag min-w-0 shrink font-normal text-muted-foreground"
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
