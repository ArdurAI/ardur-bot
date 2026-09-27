import type { Bot, RuntimeInfo, RuntimePin } from "@ardurbot/contracts";
import { runtimeNames } from "@ardurbot/contracts";
import { botEffortLabel, spaceDefaultEffort } from "@ardurbot/core";
import { Button } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { modelUnavailable, spaceDefaultUnavailable } from "../../lib/model-availability";
import type { ModelSettings } from "../../lib/use-model-settings";

export function effectiveBotModel(
  bot: Pick<
    Bot,
    "modelProvider" | "modelId" | "thinkingLevel" | "modelCredentialId" | "runtimeKind"
  >,
  settings: ModelSettings | null,
) {
  if (bot.runtimeKind && bot.runtimeKind !== "pi")
    return {
      label: bot.modelId ?? "unset model",
      providerLabel: runtimeNames[bot.runtimeKind],
      thinkingLevel: bot.thinkingLevel,
      isDefault: false,
      unavailable: !bot.modelId || (bot.runtimeKind !== "antigravity" && !bot.thinkingLevel),
    };
  if (!settings) return null;
  const { me, catalog, credentials } = settings;
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
    effortLabel:
      provider === "ollama"
        ? reasoning
          ? thinkingLevel === "off"
            ? "off"
            : "on"
          : "not applicable"
        : undefined,
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

function nextBotPin(bot: Bot, settings: ModelSettings | null): Omit<RuntimePin, "revision"> {
  const overridden = Boolean(
    bot.modelProvider != null || bot.modelId != null || bot.modelCredentialId != null,
  );
  const provider = overridden ? bot.modelProvider : (settings?.me.defaultProvider ?? null);
  const modelId = overridden ? bot.modelId : (settings?.me.defaultModel ?? null);
  const credential = settings?.credentials.find((item) =>
    bot.modelCredentialId
      ? item.id === bot.modelCredentialId && item.provider === provider
      : item.provider === provider && item.modelId === modelId,
  );
  const entry = settings?.catalog.find((item) => item.provider === provider && item.id === modelId);
  return {
    runtimeKind: bot.runtimeKind ?? "pi",
    provider,
    modelId,
    effort:
      bot.thinkingLevel ??
      (overridden
        ? null
        : (credential?.thinkingLevel ??
          spaceDefaultEffort(
            credential?.reasoning ?? entry?.reasoning,
            credential?.thinkingLevels ?? entry?.thinkingLevels,
          ))),
    credentialId: bot.modelCredentialId ?? credential?.id ?? null,
  };
}

function sameSelection(a: Omit<RuntimePin, "revision">, b: Omit<RuntimePin, "revision">): boolean {
  return (
    a.runtimeKind === b.runtimeKind &&
    a.provider === b.provider &&
    a.modelId === b.modelId &&
    a.effort === b.effort &&
    a.credentialId === b.credentialId
  );
}

export function BotModelChip({
  bot,
  settings,
  run,
  onClick,
  pin,
  display = "change",
  nextPin,
}: {
  bot: Bot;
  settings: ModelSettings | null;
  run?: { runtimePin?: RuntimePin | null; runtimeInfo?: RuntimeInfo | null } | null;
  onClick?: () => void;
  pin?: RuntimePin | null;
  nextPin?: RuntimePin | null;
  display?: "change" | "using";
}) {
  const { t } = useLingui();
  const pinUnknown = display === "using" && Boolean(run) && !run?.runtimePin;
  const requested = display === "using" ? (run?.runtimePin ?? pin) : pin;
  const displayBot = requested
    ? {
        ...bot,
        runtimeKind: requested.runtimeKind,
        modelProvider: requested.provider,
        modelId: requested.modelId,
        thinkingLevel: requested.effort as Bot["thinkingLevel"],
        modelCredentialId: requested.credentialId,
        modelPinRevision: pin ? requested.revision : bot.modelPinRevision,
      }
    : bot;
  const model = effectiveBotModel(displayBot, settings);
  if (!model) return null;
  const effort =
    displayBot.runtimeKind === "claude-code" || displayBot.runtimeKind === "antigravity"
      ? botEffortLabel(displayBot, display === "using" ? run : null, t`requested`)
      : (model.effortLabel ?? model.thinkingLevel);
  const label = `${displayBot.runtimeKind && displayBot.runtimeKind !== "pi" ? "" : "Ardur · "}${model.providerLabel} · ${model.label}${effort ? ` · ${effort}` : ""}${model.unavailable ? t` · not available` : ""}`;
  const currentId = requested?.modelId ?? displayBot.modelId ?? model.label;
  const next = nextPin ?? nextBotPin(bot, settings);
  const connection = settings?.credentials.find((item) => item.id === next.credentialId);
  const nextLabel = [
    runtimeNames[next.runtimeKind],
    next.provider,
    next.modelId,
    next.effort,
    connection?.label ?? next.credentialId,
  ]
    .filter(Boolean)
    .join(" · ");
  const nextDiffers =
    display === "using" && run?.runtimePin && !sameSelection(run.runtimePin, next);
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      {onClick ? (
        <Button
          variant="ghost"
          size="xs"
          className={`app-no-drag min-w-0 shrink font-normal ${model.unavailable ? "text-warning" : "text-muted-foreground"}`}
          aria-label={
            pinUnknown
              ? t`Next run`
              : display === "using"
                ? t`Using ${currentId}`
                : t`Change model: ${label}`
          }
          onClick={onClick}
        >
          <span className="truncate">{label}</span>
          {display === "change" && model.isDefault ? (
            <span className="text-muted-foreground/70">
              <Trans>default</Trans>
            </span>
          ) : null}
        </Button>
      ) : (
        <span
          role="status"
          aria-label={pinUnknown ? t`Next run` : t`Using ${currentId}`}
          className="truncate text-xs text-muted-foreground"
        >
          {pinUnknown ? (
            <>
              <Trans>Next run</Trans> ·{" "}
            </>
          ) : null}
          {label}
        </span>
      )}
      {nextDiffers ? (
        <details className="text-xs text-muted-foreground">
          <summary>
            <Trans>Next run</Trans>
          </summary>
          <span>{nextLabel || t`Same as bot`}</span>
        </details>
      ) : null}
    </span>
  );
}
