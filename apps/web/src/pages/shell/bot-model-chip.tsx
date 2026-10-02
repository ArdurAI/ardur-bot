import type { Bot, RuntimeInfo, RuntimePin } from "@ardurbot/contracts";
import { runtimeNames } from "@ardurbot/contracts";
import { botEffortLabel, inheritedOllamaEffort, spaceDefaultEffort } from "@ardurbot/core";
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
            (thinkingLevel &&
              levels &&
              !levels.includes(thinkingLevel) &&
              !(provider === "ollama" && reasoning === false && thinkingLevel === "off")) ||
            modelUnavailable({ catalog, credentials }, provider, modelId),
        )
      : spaceDefaultUnavailable({ me, catalog, credentials }),
  };
}

export function resolveBotModelChip(
  bot: Bot,
  settings: ModelSettings | null,
  options: {
    pin?: RuntimePin | null;
    run?: { runtimePin?: RuntimePin | null; runtimeInfo?: RuntimeInfo | null } | null;
    display?: "change" | "using";
    requested: string;
    notAvailable: string;
  },
): {
  label: string;
  currentId: string;
  pinUnknown: boolean;
  model: NonNullable<ReturnType<typeof effectiveBotModel>>;
} | null {
  const display = options.display ?? "change";
  const pin = options.pin;
  const run = options.run;
  const pinUnknown = display === "using" && Boolean(run) && !run?.runtimePin;
  const requested = display === "using" ? (run?.runtimePin ?? pin) : pin;
  const displayBot = requested
    ? {
        ...bot,
        runtimeKind: requested.runtimeKind,
        modelProvider: requested.provider,
        modelId: requested.modelId,
        thinkingLevel: (requested.provider === "ollama" && requested.effort === "none"
          ? "off"
          : requested.effort) as Bot["thinkingLevel"],
        modelCredentialId: requested.credentialId,
        modelPinRevision: pin ? requested.revision : bot.modelPinRevision,
      }
    : bot;
  const model = effectiveBotModel(displayBot, settings);
  if (!model) return null;
  const effort =
    displayBot.runtimeKind === "claude-code" || displayBot.runtimeKind === "antigravity"
      ? botEffortLabel(displayBot, display === "using" ? run : null, options.requested)
      : (model.effortLabel ?? model.thinkingLevel);
  const label = `${displayBot.runtimeKind && displayBot.runtimeKind !== "pi" ? "" : "Ardur · "}${model.providerLabel} · ${model.label}${effort ? ` · ${effort}` : ""}${model.unavailable ? options.notAvailable : ""}`;
  const currentId = requested?.modelId ?? displayBot.modelId ?? model.label;
  return { label, currentId, pinUnknown, model };
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
      : item.provider === provider && item.modelId === modelId && (overridden || item.isDefault),
  );
  const entry = settings?.catalog.find((item) => item.provider === provider && item.id === modelId);
  return {
    runtimeKind: bot.runtimeKind ?? "pi",
    provider,
    modelId,
    effort:
      provider === "ollama" && (!overridden || bot.thinkingLevel === "off")
        ? inheritedOllamaEffort(bot.thinkingLevel, credential?.reasoning ?? entry?.reasoning)
        : overridden
          ? (bot.thinkingLevel ?? null)
          : (bot.thinkingLevel ??
            credential?.thinkingLevel ??
            spaceDefaultEffort(
              credential?.reasoning ?? entry?.reasoning,
              credential?.thinkingLevels ?? entry?.thinkingLevels,
            )),
    credentialId: bot.modelCredentialId ?? credential?.id ?? null,
  };
}

function normalizeSuppliedNextPin(pin: RuntimePin, settings: ModelSettings | null): RuntimePin {
  if (pin.provider !== "ollama" || pin.effort !== "off") return pin;
  const credential = settings?.credentials.find(
    (item) => item.id === pin.credentialId && item.provider === pin.provider,
  );
  const entry = settings?.catalog.find(
    (item) => item.provider === pin.provider && item.id === pin.modelId,
  );
  return {
    ...pin,
    effort: inheritedOllamaEffort("off", credential?.reasoning ?? entry?.reasoning),
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

/** The saved choice that the next run will use, and whether the admitted run still differs from it. */
export function resolveNextRunDisclosure(
  bot: Bot,
  settings: ModelSettings | null,
  options: {
    display?: "change" | "using";
    run?: { runtimePin?: RuntimePin | null; runtimeInfo?: RuntimeInfo | null } | null;
    nextPin?: RuntimePin | null;
  },
): { label: string; differs: boolean } {
  const display = options.display ?? "change";
  const next = options.nextPin
    ? normalizeSuppliedNextPin(options.nextPin, settings)
    : nextBotPin(bot, settings);
  const connection = settings?.credentials.find((item) => item.id === next.credentialId);
  const label = [
    runtimeNames[next.runtimeKind],
    next.provider,
    next.modelId,
    next.effort,
    connection?.label ?? next.credentialId,
  ]
    .filter(Boolean)
    .join(" · ");
  // An admitted explicit group pin can still carry the stored "off"; compare both sides in
  // the same representation so an unchanged local selection never reads as a change.
  const admitted = options.run?.runtimePin;
  const differs =
    display === "using" &&
    (admitted ? !sameSelection(normalizeSuppliedNextPin(admitted, settings), next) : false);
  return { label, differs };
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
  const chip = resolveBotModelChip(bot, settings, {
    pin,
    run,
    display,
    requested: t`requested`,
    notAvailable: t` · not available`,
  });
  if (!chip) return null;
  const { label, currentId, pinUnknown, model } = chip;
  const { label: nextLabel, differs: nextDiffers } = resolveNextRunDisclosure(bot, settings, {
    display,
    run,
    nextPin,
  });
  return (
    <span className="inline-flex min-w-0 shrink items-center gap-1">
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
