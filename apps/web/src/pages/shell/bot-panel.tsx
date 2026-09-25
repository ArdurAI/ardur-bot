import type {
  AgentSkillCatalogEntry,
  Bot,
  ComputerMode,
  ModelCatalogEntry,
  RuntimeKind,
  ThinkingLevel,
  VoiceInfo,
} from "@ardurbot/contracts";
import {
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
  BOT_TITLE_MAX_LENGTH,
} from "@ardurbot/contracts";
import {
  modelPinOptionKey as modelOptionKey,
  parseModelPinOptionKey as parseModelOptionKey,
  spaceDefaultEffort,
} from "@ardurbot/core";
import {
  Button,
  Input,
  NativeSelect,
  NativeSelectOption,
  Switch,
  Textarea,
  Toggle,
} from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { X } from "lucide-react";
import { lazy, Suspense, useEffect, useId, useRef, useState } from "react";
import { BotContext } from "../../components/ContextEntry";
import { ShowAllModels } from "../../components/ShowAllModels";
import { modelUnavailable, spaceDefaultUnavailable } from "../../lib/model-availability";
import { availableProviderModels, unavailableSubscriptionModel } from "../../lib/model-options";
import { rpc } from "../../lib/rpc";
import { thinkingLevelDescription } from "../../lib/thinking-level-options";
import type { ModelSettings } from "../../lib/use-model-settings";
import { useModelSettings } from "../../lib/use-model-settings";
import { ModelDestinations } from "../ModelDestinations";
import { AvatarStudioPopover } from "./avatar-studio-popover";
import { RuntimeSettings } from "./runtime-settings";

const ScratchpadSection = lazy(() =>
  import("../ScratchpadSection").then((module) => ({ default: module.ScratchpadSection })),
);

const KnowledgeSection = lazy(() =>
  import("../KnowledgeSection").then((module) => ({ default: module.KnowledgeSection })),
);

const fieldLabelClass = "mt-4 block text-[14px] text-muted-foreground";

function ComputerModePicker({
  value,
  onChange,
  teamTestId,
  privateTestId,
}: {
  value: ComputerMode;
  onChange: (value: ComputerMode) => void;
  teamTestId?: string;
  privateTestId?: string;
}) {
  return (
    <div className="mt-4">
      <div className="text-[14px] text-muted-foreground">
        <Trans>Computer</Trans>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {(["team", "dedicated"] as const).map((mode) => (
          <Toggle
            key={mode}
            variant="outline"
            pressed={value === mode}
            data-testid={mode === "team" ? teamTestId : privateTestId}
            onPressedChange={(pressed) => {
              if (pressed) onChange(mode);
            }}
            className="capitalize aria-pressed:border-foreground/40 aria-pressed:text-foreground"
          >
            {mode === "team" ? <Trans>Team</Trans> : <Trans>Private</Trans>}
          </Toggle>
        ))}
      </div>
    </div>
  );
}

export function CreateBotForm({
  onCreate,
  onCancel,
}: {
  onCreate: (input: {
    name: string;
    title: string;
    description: string;
    computerMode: ComputerMode;
  }) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useLingui();
  const ids = useId();
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [computerMode, setComputerMode] = useState<ComputerMode>("team");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    if (!name.trim() || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await onCreate({
        name: name.trim(),
        title: title.trim(),
        description: description.trim(),
        computerMode,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not create bot`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div data-testid="create-bot-form">
      <div className="mb-4 flex items-center justify-between">
        <span className="text-[13.5px] text-muted-foreground">
          <Trans>New bot</Trans>
        </span>
        <Button variant="ghost" size="icon-sm" aria-label={t`Cancel new bot`} onClick={onCancel}>
          <X size={16} strokeWidth={1.8} />
        </Button>
      </div>
      {error ? (
        <p
          role="alert"
          data-testid="create-bot-error"
          className="mb-3 text-[13px] text-destructive"
        >
          {error}
        </p>
      ) : null}
      <label htmlFor={`${ids}-name`} className="mt-6 block text-[14px] text-muted-foreground">
        <Trans>Name</Trans>
        <Input
          id={`${ids}-name`}
          value={name}
          maxLength={BOT_NAME_MAX_LENGTH}
          onChange={(e) => setName(e.target.value)}
          placeholder={t`Name this bot`}
          className="mt-2"
        />
      </label>
      <label htmlFor={`${ids}-title`} className={fieldLabelClass}>
        <Trans>Title</Trans>
        <Input
          id={`${ids}-title`}
          value={title}
          maxLength={BOT_TITLE_MAX_LENGTH}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t`Describe what this bot does`}
          className="mt-2"
        />
      </label>
      <label htmlFor={`${ids}-description`} className={fieldLabelClass}>
        <Trans>Description</Trans>
        <Textarea
          id={`${ids}-description`}
          value={description}
          maxLength={BOT_DESCRIPTION_MAX_LENGTH}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t`What this bot is for`}
          rows={4}
          className="mt-2"
        />
      </label>
      <div data-testid="create-bot-computer">
        <ComputerModePicker
          value={computerMode}
          onChange={setComputerMode}
          teamTestId="create-bot-team"
          privateTestId="create-bot-private"
        />
      </div>
      <Button
        className="mt-5"
        disabled={!name.trim() || submitting}
        onClick={() => void handleSubmit()}
      >
        {submitting ? <Trans>Creating…</Trans> : <Trans>Create</Trans>}
      </Button>
    </div>
  );
}

export function BotSettings({
  bot,
  modelFocusRequest = 0,
  runtimeFocusRequest = 0,
  modelSettings,
  memoryProviderConfigured,
  onSkillsChange,
  onSave,
  onExport,
  onClear,
}: {
  bot: Bot;
  modelFocusRequest?: number;
  runtimeFocusRequest?: number;
  modelSettings?: ModelSettings | null;
  onSkillsChange: (skills: AgentSkillCatalogEntry[]) => void;
  memoryProviderConfigured: boolean;
  onSave: (patch: {
    name?: string;
    title?: string;
    description?: string;
    instructions?: string;
    color?: string;
    notifyOnFinish?: boolean;
    computerMode: ComputerMode;
    memoryScope?: "isolated" | "shared" | null;
    autoSpeak?: boolean;
    voiceId?: string | null;
    modelProvider?: string | null;
    modelId?: string | null;
    modelCredentialId?: string | null;
    runtimeKind?: RuntimeKind;
    runtimeExperimental?: boolean;
    thinkingLevel?: ThinkingLevel | null;
  }) => Promise<void>;
  onExport: () => Promise<void>;
  onClear: () => void;
}) {
  const { t } = useLingui();
  const [advancedOpened, setAdvancedOpened] = useState(false);
  const modelRef = useRef<HTMLSelectElement>(null);
  const runtimeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!runtimeFocusRequest) return;
    runtimeRef.current?.querySelector("select")?.focus();
    runtimeRef.current?.scrollIntoView({ block: "nearest" });
  }, [runtimeFocusRequest]);
  useEffect(() => {
    if (!modelFocusRequest) return;
    modelRef.current?.focus();
    modelRef.current?.scrollIntoView({ block: "nearest" });
  }, [modelFocusRequest]);
  const ids = useId();
  const [name, setName] = useState(bot.name);
  const [title, setTitle] = useState(bot.title);
  const [description, setDescription] = useState(bot.description);
  const [color, setColor] = useState(bot.color);
  const [notifyOnFinish, setNotifyOnFinish] = useState(bot.notifyOnFinish ?? true);
  const [computerMode, setComputerMode] = useState(bot.computerMode);
  const [memoryScope, setMemoryScope] = useState(bot.memoryScope);
  const [autoSpeak, setAutoSpeak] = useState(bot.autoSpeak);
  const [voiceId, setVoiceId] = useState(bot.voiceId ?? "");
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [runtimeExperimental, setRuntimeExperimental] = useState(bot.runtimeExperimental ?? false);
  const [runtimeKind, setRuntimeKind] = useState<RuntimeKind>(bot.runtimeKind ?? "pi");
  const [modelKey, setModelKey] = useState(
    bot.modelProvider && bot.modelId
      ? modelOptionKey(bot.modelProvider, bot.modelId, bot.modelCredentialId)
      : "",
  );
  const [thinkingLevel, setThinkingLevel] = useState(bot.thinkingLevel ?? "");
  const loadedSettings = useModelSettings(undefined, false, modelSettings === undefined);
  const metadata = modelSettings === undefined ? loadedSettings : modelSettings;
  const credentials = metadata?.credentials ?? [];
  const catalog = metadata?.catalog ?? [];
  const me = metadata?.me;
  const modelMetaReady = metadata !== null;
  const [showAllModels, setShowAllModels] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saveQueueRef = useRef(Promise.resolve());
  const executeSaveRef = useRef<
    (patchOverrides?: {
      name?: string;
      title?: string;
      description?: string;
      color?: string;
      notifyOnFinish?: boolean;
    }) => Promise<void>
  >(async () => undefined);
  useEffect(() => {
    void rpc.voice
      .voices({})
      .then(setVoices)
      .catch(() => setVoices([]));
  }, []);

  const connectedOptions: Array<{
    key: string;
    provider: string;
    modelId: string;
    label: string;
  }> = [];
  const seenOptions = new Set<string>();
  for (const credential of credentials) {
    const providerModels = availableProviderModels(
      catalog,
      credential.provider,
      showAllModels,
    ).filter(
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
    // Catalog providers expand to every model for that connection. Free-form
    // credentials (model id not in the catalog) stay a single connected pair.
    const options =
      credential.provider !== "ollama" &&
      credential.modelId &&
      !credentialInCatalog &&
      (showAllModels ||
        !unavailableSubscriptionModel(catalog, credential.provider, credential.modelId))
        ? [
            {
              key: modelOptionKey(credential.provider, credential.modelId, credential.id),
              provider: credential.provider,
              modelId: credential.modelId,
              label: `${credential.label} · ${credential.modelId}`,
            },
          ]
        : providerModels.map((entry) => ({
            key: modelOptionKey(entry.provider, entry.id, credential.id),
            provider: entry.provider,
            modelId: entry.id,
            label: `${
              credentials.filter((item) => item.provider === credential.provider).length > 1
                ? credential.label
                : (entry.providerName ?? entry.provider)
            } · ${entry.label}`,
          }));
    for (const option of options) {
      if (seenOptions.has(option.key)) continue;
      seenOptions.add(option.key);
      connectedOptions.push(option);
    }
  }

  const effectiveProvider = modelKey
    ? parseModelOptionKey(modelKey)?.provider
    : (me?.defaultProvider ?? null);
  const effectiveModelId = modelKey
    ? parseModelOptionKey(modelKey)?.modelId
    : (me?.defaultModel ?? null);
  const effectiveEntry =
    effectiveProvider && effectiveModelId
      ? catalog.find(
          (entry) => entry.provider === effectiveProvider && entry.id === effectiveModelId,
        )
      : undefined;
  const selectedModel = parseModelOptionKey(modelKey);
  const effectiveCredential = credentials.find((entry) =>
    selectedModel
      ? entry.id === selectedModel.credentialId
      : entry.provider === effectiveProvider && entry.modelId === effectiveModelId,
  );
  const supportedThinking =
    effectiveCredential?.thinkingLevels ?? effectiveEntry?.thinkingLevels ?? [];
  const isOllama = effectiveProvider === "ollama";
  const thinkingOptions: ThinkingLevel[] = supportedThinking.filter((level) =>
    isOllama ? level === "off" || level === "medium" : level !== "off",
  );
  const defaultThinkingLevel =
    effectiveCredential?.thinkingLevel ?? spaceDefaultEffort(undefined, supportedThinking);
  const unavailableDefault = metadata ? spaceDefaultUnavailable(metadata) : false;
  const needsConnection = Boolean(selectedModel && !selectedModel.credentialId);
  const unavailableSelection =
    needsConnection ||
    (modelMetaReady &&
      modelUnavailable({ catalog, credentials }, selectedModel?.provider, selectedModel?.modelId));

  async function executeSave(patchOverrides?: {
    name?: string;
    title?: string;
    description?: string;
    color?: string;
    notifyOnFinish?: boolean;
  }) {
    const selected = modelKey ? parseModelOptionKey(modelKey) : null;
    const nextName = (patchOverrides?.name !== undefined ? patchOverrides.name : name).trim();
    const nextTitle = (patchOverrides?.title !== undefined ? patchOverrides.title : title).trim();
    const nextDescription = (
      patchOverrides?.description !== undefined ? patchOverrides.description : description
    ).trim();
    const nextColor = patchOverrides?.color !== undefined ? patchOverrides.color : color;
    const nextNotify =
      patchOverrides?.notifyOnFinish !== undefined ? patchOverrides.notifyOnFinish : notifyOnFinish;

    if (nextName) setName(nextName);
    setTitle(nextTitle);
    setDescription(nextDescription);

    try {
      setSaving(true);
      setError(null);
      await onSave({
        name: nextName || bot.name,
        title: nextTitle,
        description: nextDescription,
        instructions: nextDescription,
        // Unchanged color stays off the wire so a legacy named value cannot fail a name save.
        ...(nextColor !== bot.color ? { color: nextColor } : {}),
        notifyOnFinish: nextNotify,
        computerMode,
        memoryScope,
        autoSpeak,
        voiceId: voiceId || null,
        runtimeKind,
        runtimeExperimental,
        modelProvider: selected?.provider ?? null,
        modelId: selected?.modelId ?? null,
        modelCredentialId: selected
          ? (selected.credentialId ?? bot.modelCredentialId ?? null)
          : null,
        ...(runtimeKind !== "pi" || modelMetaReady
          ? {
              thinkingLevel: (isOllama && !effectiveEntry?.reasoning
                ? null
                : thinkingLevel || null) as ThinkingLevel | null,
            }
          : {}),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not save`);
    } finally {
      setSaving(false);
    }
  }
  executeSaveRef.current = executeSave;

  function enqueueSave(patchOverrides?: {
    name?: string;
    title?: string;
    description?: string;
    color?: string;
    notifyOnFinish?: boolean;
  }) {
    // Serialize full-object auto-saves so an older in-flight request cannot
    // finish after a newer one and clobber fields. Always call through a ref so
    // queued work reads the latest field values, not a stale render closure.
    saveQueueRef.current = saveQueueRef.current
      .catch(() => undefined)
      .then(() => executeSaveRef.current(patchOverrides));
    return saveQueueRef.current;
  }

  return (
    <div data-testid="bot-settings">
      <div className="flex justify-center py-4">
        <AvatarStudioPopover
          value={color}
          identity={bot.id}
          status={bot.status}
          size={76}
          onChange={(newColor) => {
            setColor(newColor);
            void enqueueSave({ color: newColor });
          }}
        />
      </div>
      <label htmlFor={`${ids}-name`} className="mt-4 block text-[13.5px] text-muted-foreground/80">
        <Trans>Name</Trans>
        <Input
          id={`${ids}-name`}
          value={name}
          maxLength={BOT_NAME_MAX_LENGTH}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => void enqueueSave()}
          className="mt-1.5"
        />
      </label>
      <label htmlFor={`${ids}-title`} className={fieldLabelClass}>
        <Trans>Title</Trans>
        <Input
          id={`${ids}-title`}
          value={title}
          maxLength={BOT_TITLE_MAX_LENGTH}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => void enqueueSave()}
          placeholder={t`e.g. Hivenet Agent, Presales, Timesheets bot`}
          className="mt-1.5"
        />
      </label>
      <label htmlFor={`${ids}-description`} className={fieldLabelClass}>
        <Trans>Description</Trans>
        <Textarea
          id={`${ids}-description`}
          value={description}
          maxLength={BOT_DESCRIPTION_MAX_LENGTH}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => void enqueueSave()}
          rows={3}
          className="mt-1.5"
        />
      </label>
      <div className="mt-6 flex items-center justify-between pt-4 border-t border-border/20">
        <div className="space-y-0.5 pe-4">
          <div
            id={`${ids}-notify-finish-label`}
            className="text-[13.5px] font-medium text-foreground"
          >
            <Trans>Notifications</Trans>
          </div>
          <div id={`${ids}-notify-finish-desc`} className="text-[12px] text-muted-foreground/70">
            <Trans>Get notified when this Bot finishes or needs input</Trans>
          </div>
        </div>
        <Switch
          id={`${ids}-notify-finish`}
          checked={notifyOnFinish}
          aria-labelledby={`${ids}-notify-finish-label`}
          aria-describedby={`${ids}-notify-finish-desc`}
          onCheckedChange={(checked) => {
            setNotifyOnFinish(checked);
            void enqueueSave({ notifyOnFinish: checked });
          }}
        />
      </div>
      <BotContext botId={bot.id} />
      <ModelDestinations botId={bot.id} />
      <div ref={runtimeRef}>
        <RuntimeSettings
          experimental={runtimeExperimental}
          onExperimental={setRuntimeExperimental}
          kind={runtimeKind}
          onKind={setRuntimeKind}
          modelKey={modelKey}
          onModel={setModelKey}
          effort={thinkingLevel}
          onEffort={setThinkingLevel}
        />
      </div>
      {runtimeKind === "pi" ? (
        <>
          <label htmlFor={`${ids}-model`} className={fieldLabelClass}>
            <Trans>Model</Trans>
            <NativeSelect
              ref={modelRef}
              id={`${ids}-model`}
              className="mt-2 w-full"
              value={modelKey}
              onChange={(event) => {
                setModelKey(event.target.value);
                setThinkingLevel("");
              }}
            >
              <NativeSelectOption value="">
                {t`Space default`}
                {me?.defaultModel
                  ? ` (${catalogLabel(catalog, me.defaultProvider, me.defaultModel) ?? me.defaultModel}${
                      unavailableDefault ? t` — not available on your account` : ""
                    })`
                  : ""}
              </NativeSelectOption>
              {modelKey && !connectedOptions.some((option) => option.key === modelKey) ? (
                <NativeSelectOption
                  value={modelKey}
                  className={unavailableSelection ? "text-muted-foreground" : undefined}
                >
                  {needsConnection ? `${selectedModel?.provider} · ` : ""}
                  {parseModelOptionKey(modelKey)?.modelId ?? modelKey}
                  {unavailableSelection ? t` (not available on your account)` : ""}
                </NativeSelectOption>
              ) : null}
              {([false, true] as const).map((local) => (
                <optgroup key={String(local)} label={local ? t`Local` : t`Hosted providers`}>
                  {connectedOptions
                    .filter(
                      (option) =>
                        (option.provider === "ollama" || option.provider === "local") === local,
                    )
                    .map((option) => (
                      <NativeSelectOption
                        key={option.key}
                        value={option.key}
                        className={
                          unavailableSubscriptionModel(catalog, option.provider, option.modelId)
                            ? "text-muted-foreground"
                            : undefined
                        }
                      >
                        {option.label}
                        {unavailableSubscriptionModel(catalog, option.provider, option.modelId)
                          ? t` — May not be available on your plan`
                          : ""}
                      </NativeSelectOption>
                    ))}
                </optgroup>
              ))}
            </NativeSelect>
          </label>
          {catalog.some(
            (entry) =>
              credentials.some((credential) => credential.provider === entry.provider) &&
              unavailableSubscriptionModel(catalog, entry.provider, entry.id),
          ) ? (
            <ShowAllModels checked={showAllModels} onChange={setShowAllModels} />
          ) : null}
          {!needsConnection && (modelKey ? unavailableSelection : unavailableDefault) ? (
            <p className="mt-2 text-[12px] text-muted-foreground">
              <Trans>This model is not available on your account. Choose another model.</Trans>
            </p>
          ) : null}
          {isOllama && effectiveEntry?.reasoning === false ? (
            <p className="mt-2 text-sm text-muted-foreground">
              <Trans>Effort: not applicable</Trans>
            </p>
          ) : thinkingOptions.length || thinkingLevel ? (
            <label htmlFor={`${ids}-thinking`} className={fieldLabelClass}>
              <Trans>Thinking</Trans>
              <NativeSelect
                id={`${ids}-thinking`}
                className="mt-2 w-full"
                value={
                  isOllama && ["", "low", "medium", "high"].includes(thinkingLevel)
                    ? "medium"
                    : thinkingLevel
                }
                onChange={(event) => setThinkingLevel(event.target.value)}
              >
                {!isOllama ? (
                  <NativeSelectOption value="">
                    {t`Default (${thinkingLevelDescription(defaultThinkingLevel)})`}
                  </NativeSelectOption>
                ) : null}
                {thinkingLevel &&
                !(isOllama && ["low", "medium", "high"].includes(thinkingLevel)) &&
                !thinkingOptions.includes(thinkingLevel as ThinkingLevel) ? (
                  <NativeSelectOption value={thinkingLevel}>
                    {isOllama
                      ? thinkingLevel === "off"
                        ? t`Off`
                        : t`On`
                      : thinkingLevelDescription(thinkingLevel as ThinkingLevel)}
                  </NativeSelectOption>
                ) : null}
                {thinkingOptions.map((level) => (
                  <NativeSelectOption key={level} value={level}>
                    {isOllama
                      ? level === "off"
                        ? t`Off`
                        : t`On`
                      : thinkingLevelDescription(level)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
          ) : null}
        </>
      ) : null}
      <details
        data-testid="bot-settings-advanced"
        className="group mt-5"
        onToggle={(event) => {
          if (event.currentTarget.open) setAdvancedOpened(true);
        }}
      >
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[14px] text-muted-foreground">
          <span className="text-muted-foreground">
            <Trans>Advanced</Trans>
          </span>
          <span aria-hidden="true" className="transition-transform group-open:rotate-90">
            ›
          </span>
        </summary>
        <ComputerModePicker value={computerMode} onChange={setComputerMode} />
        <Suspense fallback={null}>
          <ScratchpadSection botId={bot.id} />
          {advancedOpened ? (
            <KnowledgeSection botId={bot.id} onSkillsChange={onSkillsChange} />
          ) : null}
        </Suspense>
        {memoryProviderConfigured ? (
          <div className="mt-4 text-[14px] text-muted-foreground">
            <Trans>Memory scope</Trans>
            <div className="mt-2 flex gap-2">
              {(
                [
                  { value: null, label: t`Inherit default` },
                  { value: "isolated" as const, label: t`Isolated` },
                  { value: "shared" as const, label: t`Shared` },
                ] satisfies Array<{ value: "isolated" | "shared" | null; label: string }>
              ).map((option) => (
                <Toggle
                  key={option.label}
                  variant="outline"
                  size="sm"
                  pressed={memoryScope === option.value}
                  onPressedChange={(pressed) => {
                    if (pressed) setMemoryScope(option.value);
                  }}
                  className="flex-1 aria-pressed:border-foreground/40 aria-pressed:text-foreground"
                >
                  {option.label}
                </Toggle>
              ))}
            </div>
          </div>
        ) : null}
        <label
          htmlFor={`${ids}-auto-speak`}
          className="mt-5 flex cursor-pointer items-center gap-3 text-[14px] text-foreground/75"
        >
          <Switch
            id={`${ids}-auto-speak`}
            checked={autoSpeak}
            onCheckedChange={(checked) => setAutoSpeak(checked)}
          />
          <Trans>Read replies aloud</Trans>
        </label>
        {voices.length ? (
          <label htmlFor={`${ids}-voice`} className={fieldLabelClass}>
            <Trans>Voice</Trans>
            <NativeSelect
              id={`${ids}-voice`}
              className="mt-2 w-full"
              value={voiceId}
              onChange={(event) => setVoiceId(event.target.value)}
            >
              <NativeSelectOption value="">{t`Account default`}</NativeSelectOption>
              {voices.map((voice) => (
                <NativeSelectOption key={voice.id} value={voice.id}>
                  {voice.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
        ) : null}
      </details>
      {error ? <p className="mt-2 text-[13px] text-destructive">{error}</p> : null}
      {needsConnection ? (
        <p className="mt-2 text-[12px] text-muted-foreground">
          <Trans>This bot's connection needs to be chosen. Pick the connection to use.</Trans>
        </p>
      ) : null}
      <div className="mt-5 flex flex-col items-start gap-3">
        <Button
          disabled={saving}
          onClick={() => {
            void enqueueSave({
              name,
              title,
              description,
              color,
              notifyOnFinish,
            });
          }}
        >
          <Trans>Save</Trans>
        </Button>
        <Button variant="ghost" size="sm" className="-ms-2.5" onClick={() => void onExport()}>
          <Trans>Export</Trans>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="-ms-2.5 text-destructive hover:text-destructive"
          onClick={onClear}
        >
          <Trans>Clear conversation</Trans>
        </Button>
      </div>
    </div>
  );
}

function catalogLabel(
  catalog: ModelCatalogEntry[],
  provider: string | null | undefined,
  modelId: string,
) {
  if (!provider) return undefined;
  return catalog.find((entry) => entry.provider === provider && entry.id === modelId)?.label;
}
