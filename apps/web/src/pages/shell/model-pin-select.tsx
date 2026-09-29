import type { ThinkingLevel } from "@ardurbot/contracts";
import { modelPinOptionKey, parseModelPinOptionKey } from "@ardurbot/core";
import { NativeSelect, NativeSelectOption } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import type { Ref } from "react";
import { availableProviderModels, unavailableSubscriptionModel } from "../../lib/model-options";
import { thinkingLevelDescription } from "../../lib/thinking-level-options";
import type { ModelSettings } from "../../lib/use-model-settings";

/** One connection-aware model list for bot and group settings. */
export function ModelPinSelect({
  settings,
  showAll,
  value,
  onChange,
  defaultLabel,
  id,
  disabled,
  inputRef,
  unavailableSelection = false,
  needsConnection = false,
  isCredentialDisabled,
}: {
  settings: ModelSettings | null;
  showAll: boolean;
  value: string;
  onChange: (value: string) => void;
  defaultLabel?: string;
  id: string;
  disabled?: boolean;
  inputRef?: Ref<HTMLSelectElement>;
  unavailableSelection?: boolean;
  needsConnection?: boolean;
  /** Connections that stay visible but cannot be picked (e.g. sign-ins for Hermes). */
  isCredentialDisabled?: (credential: ModelSettings["credentials"][number]) => boolean;
}) {
  const { t } = useLingui();
  const catalog = settings?.catalog ?? [];
  const credentials = settings?.credentials ?? [];
  const options: Array<{
    key: string;
    provider: string;
    modelId: string;
    label: string;
    disabled?: boolean;
  }> = [];
  const seen = new Set<string>();
  for (const credential of credentials) {
    const credentialDisabled = isCredentialDisabled?.(credential) ?? false;
    const providerModels = availableProviderModels(catalog, credential.provider, showAll).filter(
      (entry) =>
        !entry.placeholder && (!entry.credentialId || entry.credentialId === credential.id),
    );
    const credentialInCatalog = Boolean(
      credential.modelId &&
        catalog.some(
          (entry) =>
            entry.provider === credential.provider &&
            entry.id === credential.modelId &&
            !entry.placeholder,
        ),
    );
    const candidates =
      credential.provider !== "ollama" &&
      credential.modelId &&
      !credentialInCatalog &&
      (showAll || !unavailableSubscriptionModel(catalog, credential.provider, credential.modelId))
        ? [
            {
              key: modelPinOptionKey(credential.provider, credential.modelId, credential.id),
              provider: credential.provider,
              modelId: credential.modelId,
              label: `${credential.label} · ${credential.modelId}`,
              disabled: credentialDisabled,
            },
          ]
        : providerModels.map((entry) => ({
            key: modelPinOptionKey(entry.provider, entry.id, credential.id),
            provider: entry.provider,
            modelId: entry.id,
            label: `${
              credentials.filter((item) => item.provider === credential.provider).length > 1
                ? credential.label
                : (entry.providerName ?? entry.provider)
            } · ${entry.label}`,
            disabled: credentialDisabled,
          }));
    for (const option of candidates) {
      if (seen.has(option.key)) continue;
      seen.add(option.key);
      options.push(option);
    }
  }
  const saved = parseModelPinOptionKey(value);
  return (
    <NativeSelect
      ref={inputRef}
      id={id}
      className="mt-2 w-full"
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      {defaultLabel !== undefined ? (
        <NativeSelectOption value="">{defaultLabel}</NativeSelectOption>
      ) : !value ? (
        <NativeSelectOption value="" disabled hidden>
          {t`Choose a model`}
        </NativeSelectOption>
      ) : null}
      {value && !options.some((option) => option.key === value) ? (
        <NativeSelectOption
          value={value}
          className={unavailableSelection ? "text-muted-foreground" : undefined}
        >
          {needsConnection ? `${saved?.provider} · ` : ""}
          {saved?.modelId ?? value}
          {unavailableSelection ? t` (not available on your account)` : ""}
        </NativeSelectOption>
      ) : null}
      {([false, true] as const).map((local) => (
        <optgroup key={String(local)} label={local ? t`Local` : t`Hosted providers`}>
          {options
            .filter(
              (option) => (option.provider === "ollama" || option.provider === "local") === local,
            )
            .map((option) => (
              <NativeSelectOption key={option.key} value={option.key} disabled={option.disabled}>
                {option.label}
                {unavailableSubscriptionModel(catalog, option.provider, option.modelId)
                  ? t` — May not be available on your plan`
                  : ""}
              </NativeSelectOption>
            ))}
        </optgroup>
      ))}
    </NativeSelect>
  );
}

/** The same supported effort choices in bot and group model settings. */
export function ModelEffortSelect({
  id,
  value,
  onChange,
  supported,
  isOllama,
  defaultLevel,
  disabled,
  notApplicable = false,
  allowDefault = true,
  hideLabel = false,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  supported: ThinkingLevel[];
  isOllama: boolean;
  defaultLevel: ThinkingLevel;
  disabled?: boolean;
  notApplicable?: boolean;
  allowDefault?: boolean;
  hideLabel?: boolean;
}) {
  const { t } = useLingui();
  const options = supported.filter((level) =>
    isOllama ? level === "off" || level === "medium" : level !== "off",
  );
  if (notApplicable)
    return (
      <p className="mt-2 text-sm text-muted-foreground">
        <Trans>Effort: not applicable</Trans>
      </p>
    );
  if (!options.length && !value) return null;
  return (
    <label htmlFor={id} className="mt-4 block text-[14px] text-muted-foreground">
      {!hideLabel ? (
        <Trans>Thinking</Trans>
      ) : (
        <span className="sr-only">
          <Trans>Thinking</Trans>
        </span>
      )}
      <NativeSelect
        id={id}
        className="mt-2 w-full"
        value={isOllama && ["", "low", "medium", "high"].includes(value) ? "medium" : value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
      >
        {!isOllama && allowDefault ? (
          <NativeSelectOption value="">
            {t`Default (${thinkingLevelDescription(defaultLevel)})`}
          </NativeSelectOption>
        ) : null}
        {value &&
        !(isOllama && ["low", "medium", "high"].includes(value)) &&
        !options.includes(value as ThinkingLevel) ? (
          <NativeSelectOption value={value}>
            {isOllama
              ? value === "off"
                ? t`Off`
                : t`On`
              : thinkingLevelDescription(value as ThinkingLevel)}
          </NativeSelectOption>
        ) : null}
        {options.map((level) => (
          <NativeSelectOption key={level} value={level}>
            {isOllama ? (level === "off" ? t`Off` : t`On`) : thinkingLevelDescription(level)}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </label>
  );
}
