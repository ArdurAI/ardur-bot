import type {
  AgentSkillCatalogEntry,
  Bot,
  ComputerMode,
  Group,
  ModelCatalogEntry,
  RuntimeKind,
  ThinkingLevel,
  VoiceInfo,
} from "@ardurbot/contracts";
import {
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
  BOT_TITLE_MAX_LENGTH,
  computerKindFacts,
  errorDataCode,
  ISOLATED_COMPUTER_UNAVAILABLE_CODE,
  recommendedContainer,
} from "@ardurbot/contracts";
import type {
  HermesRuntimeConfigV2,
  HistoricalHermesRuntimeConfig,
} from "@ardurbot/contracts/runtime-config";
import {
  hermesConnectionRefusal,
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
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useId, useRef, useState } from "react";
import { BotContext } from "../../components/ContextEntry";
import { FeatureDocsLink } from "../../components/FeatureDocsLink";
import { SettingsGroup } from "../../components/SettingsRow";
import { ShowAllModels } from "../../components/ShowAllModels";
import { hermesRefusalMessage } from "../../lib/hermes-refusal";
import { modelUnavailable, spaceDefaultUnavailable } from "../../lib/model-availability";
import { unavailableSubscriptionModel } from "../../lib/model-options";
import { rpc } from "../../lib/rpc";
import type { ModelSettings } from "../../lib/use-model-settings";
import { useModelSettings } from "../../lib/use-model-settings";
import { ModelDestinations } from "../ModelDestinations";
import { AvatarStudioPopover } from "./avatar-studio-popover";
import { ModelEffortSelect, ModelPinSelect } from "./model-pin-select";
import { RuntimeSettings } from "./runtime-settings";
import { BotRuntimeSettings, RuntimeBoundary } from "./runtime-summary";

const ScratchpadSection = lazy(() =>
  import("../ScratchpadSection").then((module) => ({ default: module.ScratchpadSection })),
);

const KnowledgeSection = lazy(() =>
  import("../KnowledgeSection").then((module) => ({ default: module.KnowledgeSection })),
);

const RuntimeConfigPanel = lazy(() =>
  import("./runtime-config-panel").then((module) => ({ default: module.RuntimeConfigPanel })),
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
    <div className="grid grid-cols-2 gap-2">
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
          {mode === "team" ? <Trans>Shared with team</Trans> : <Trans>Only this bot</Trans>}
        </Toggle>
      ))}
    </div>
  );
}

export function CreateBotForm({
  onCreate,
  onCancel,
  onSetupComputer,
}: {
  onCreate: (input: {
    name: string;
    title: string;
    description: string;
    computerMode: ComputerMode;
    isolatedComputer?: { connectionId: string | null };
  }) => Promise<void>;
  onCancel: () => void;
  onSetupComputer?: () => void;
}) {
  const { t } = useLingui();
  const ids = useId();
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [computerMode, setComputerMode] = useState<ComputerMode>("dedicated");
  const [container, setContainer] = useState<{ connectionId: string | null } | null>(null);
  const [locationReady, setLocationReady] = useState(false);
  const [containerName, setContainerName] = useState("");
  const [teamKind, setTeamKind] = useState("");
  const [locationRevision, setLocationRevision] = useState(0);
  useEffect(() => {
    const reload = () => setLocationRevision((value) => value + 1);
    window.addEventListener("fleet:changed", reload);
    return () => window.removeEventListener("fleet:changed", reload);
  }, []);
  useEffect(() => {
    let active = true;
    setLocationReady(false);
    setContainer(null);
    void Promise.all([rpc.me(), rpc.computer.connections(), rpc.computer.list()])
      .then(([me, connections, computers]) => {
        if (active) {
          const recommendation = recommendedContainer(me.sandboxProvider, connections);
          setTeamKind(
            computers.find((entry) => entry.status.mode === "team")?.status.kind ??
              me.sandboxProvider,
          );
          setContainer(recommendation);
          setContainerName(
            connections.find((entry) => entry.id === recommendation?.connectionId)?.name ??
              me.sandboxProvider,
          );
          setLocationReady(true);
        }
      })
      .catch(() => {
        if (active) setLocationReady(true);
      });
    return () => {
      active = false;
    };
  }, [locationRevision]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const computerReady =
    locationReady &&
    (computerMode === "dedicated" ? Boolean(container) : Boolean(computerKindFacts(teamKind)));
  async function handleSubmit() {
    if (!name.trim() || submitting || !computerReady) return;
    setError(null);
    setSubmitting(true);
    try {
      await onCreate({
        name: name.trim(),
        title: title.trim(),
        description: description.trim(),
        computerMode,
        ...(computerMode === "dedicated" ? { isolatedComputer: container } : {}),
      });
    } catch (err) {
      const refusal = errorDataCode(err) === ISOLATED_COMPUTER_UNAVAILABLE_CODE;
      setError(
        refusal
          ? t`Set up a container for isolated work.`
          : err instanceof Error
            ? err.message
            : t`Could not create bot`,
      );
      if (refusal) setLocationRevision((value) => value + 1);
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
        <FeatureDocsLink featureId="bots-create" title={t`New bot`} step="open-new-bot-form" />
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
      <div data-testid="create-bot-computer" className="mt-4">
        <div className="mb-2 text-[14px] text-muted-foreground">
          <Trans>Where this bot runs</Trans>
        </div>
        {container && computerMode === "dedicated" ? (
          <div className="mb-3 text-sm">
            <RuntimeBoundary kind="docker" locationName={containerName} />
          </div>
        ) : null}
        <ComputerModePicker
          value={computerMode}
          onChange={setComputerMode}
          teamTestId="create-bot-team"
          privateTestId="create-bot-private"
        />
        {computerMode === "team" ? (
          <p className="mt-2 text-sm text-muted-foreground">
            <Trans>Bots share files and installed tools</Trans>
          </p>
        ) : null}
        {computerMode === "team" && teamKind ? (
          <div className="mt-2 text-sm">
            <RuntimeBoundary kind={teamKind} />
          </div>
        ) : null}
        {computerMode === "dedicated" && locationReady && !container ? (
          <div className="mt-2 text-sm">
            <p>
              <Trans>Set up a container for isolated work.</Trans>
            </p>
            <Button variant="outline" onClick={onSetupComputer}>
              <Trans>Set up computer</Trans>
            </Button>
          </div>
        ) : null}
      </div>
      <Button
        className="mt-5"
        disabled={!name.trim() || submitting || !computerReady}
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
  destinationsFocusRequest = 0,
  computerFocusRequest = 0,
  modelSettings,
  memoryProviderConfigured,
  onSkillsChange,
  onSave,
  onExport,
  onClear,
  overrideGroups = [],
  onOpenGroup,
}: {
  bot: Bot;
  modelFocusRequest?: number;
  runtimeFocusRequest?: number;
  destinationsFocusRequest?: number;
  computerFocusRequest?: number;
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
    runtimeConfig?: HermesRuntimeConfigV2;
    expectedModelPinRevision?: number;
    runtimeExperimental?: boolean;
    thinkingLevel?: ThinkingLevel | null;
  }) => Promise<{ modelPinRevision?: number } | Bot | undefined>;
  onExport: () => Promise<void>;
  onClear: () => void;
  overrideGroups?: Group[];
  onOpenGroup?: (groupId: string) => void;
}) {
  const { t } = useLingui();
  const [advancedOpened, setAdvancedOpened] = useState(false);
  const [knowledgeTab, setKnowledgeTab] = useState<"memory" | "skills" | "learning">("memory");
  const knowledgeRef = useRef<HTMLDivElement>(null);
  const advancedDetailsRef = useRef<HTMLDetailsElement>(null);
  const modelRef = useRef<HTMLSelectElement>(null);
  const runtimeRef = useRef<HTMLDivElement>(null);
  const destinationsRef = useRef<HTMLDivElement>(null);
  const computerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!runtimeFocusRequest) return;
    runtimeRef.current?.querySelector("select")?.focus();
    runtimeRef.current?.scrollIntoView({ block: "nearest" });
  }, [runtimeFocusRequest]);
  // A destinations refusal points at the bot's own destinations select.
  useEffect(() => {
    if (!destinationsFocusRequest) return;
    destinationsRef.current?.querySelector("select")?.focus();
    destinationsRef.current?.scrollIntoView({ block: "nearest" });
  }, [destinationsFocusRequest]);
  // Computer refusals point at the ordinary settings card.
  useEffect(() => {
    if (!computerFocusRequest) return;
    computerRef.current?.scrollIntoView({ block: "nearest" });
  }, [computerFocusRequest]);
  // The model select exists only for the built-in runtime, and a focus request can arrive
  // while another runtime is shown or before the select has rendered; the request stays
  // pending until the select mounts, so it is honoured exactly once without timers.
  const pendingModelFocus = useRef(0);
  const focusModel = useCallback(() => {
    const select = modelRef.current;
    if (!select) return;
    select.focus();
    select.scrollIntoView({ block: "nearest" });
    pendingModelFocus.current = 0;
  }, []);
  useEffect(() => {
    if (!modelFocusRequest) return;
    pendingModelFocus.current = modelFocusRequest;
    focusModel();
  }, [modelFocusRequest, focusModel]);
  const attachModelRef = useCallback(
    (select: HTMLSelectElement | null) => {
      modelRef.current = select;
      if (select && pendingModelFocus.current) focusModel();
    },
    [focusModel],
  );
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
  const [runtimeConfig, setRuntimeConfig] = useState<HistoricalHermesRuntimeConfig | null>(
    bot.runtimeConfig ?? null,
  );
  const [modelKey, setModelKey] = useState(
    bot.modelProvider && bot.modelId
      ? modelOptionKey(bot.modelProvider, bot.modelId, bot.modelCredentialId)
      : "",
  );
  const [thinkingLevel, setThinkingLevel] = useState(bot.thinkingLevel ?? "");

  const [seededBot, setSeededBot] = useState(bot);
  const [draftPinRevision, setDraftPinRevision] = useState(bot.modelPinRevision ?? 0);

  useEffect(() => {
    const currentRev = bot.modelPinRevision ?? 0;
    if (currentRev > draftPinRevision) {
      const isClean =
        runtimeKind === (seededBot.runtimeKind ?? "pi") &&
        JSON.stringify(runtimeConfig) === JSON.stringify(seededBot.runtimeConfig ?? null) &&
        runtimeExperimental === (seededBot.runtimeExperimental ?? false) &&
        modelKey ===
          (seededBot.modelProvider && seededBot.modelId
            ? modelOptionKey(
                seededBot.modelProvider,
                seededBot.modelId,
                seededBot.modelCredentialId,
              )
            : "") &&
        thinkingLevel === (seededBot.thinkingLevel ?? "") &&
        title === (seededBot.title ?? "") &&
        name === (seededBot.name ?? "");
      const draftMatchesIncoming =
        runtimeKind === (bot.runtimeKind ?? "pi") &&
        JSON.stringify(runtimeConfig) === JSON.stringify(bot.runtimeConfig ?? null) &&
        runtimeExperimental === (bot.runtimeExperimental ?? false) &&
        modelKey ===
          (bot.modelProvider && bot.modelId
            ? modelOptionKey(bot.modelProvider, bot.modelId, bot.modelCredentialId)
            : "") &&
        thinkingLevel === (bot.thinkingLevel ?? "") &&
        title === (bot.title ?? "") &&
        name === (bot.name ?? "");

      if (isClean || draftMatchesIncoming) {
        setRuntimeKind(bot.runtimeKind ?? "pi");
        setRuntimeConfig(bot.runtimeConfig ?? null);
        setRuntimeExperimental(bot.runtimeExperimental ?? false);
        setModelKey(
          bot.modelProvider && bot.modelId
            ? modelOptionKey(bot.modelProvider, bot.modelId, bot.modelCredentialId)
            : "",
        );
        setThinkingLevel(bot.thinkingLevel ?? "");
        setDraftPinRevision(currentRev);
        setSeededBot(bot);
      }
    }
  }, [
    bot,
    draftPinRevision,
    runtimeKind,
    runtimeConfig,
    runtimeExperimental,
    modelKey,
    thinkingLevel,
    seededBot,
  ]);
  const loadedSettings = useModelSettings(undefined, false, modelSettings === undefined);
  const metadata = modelSettings === undefined ? loadedSettings : modelSettings;
  const credentials = metadata?.credentials ?? [];
  const catalog = metadata?.catalog ?? [];
  const me = metadata?.me;
  const modelMetaReady = metadata !== null;
  const [showAllModels, setShowAllModels] = useState(false);
  const [saving, setSaving] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
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
  const defaultThinkingLevel =
    effectiveCredential?.thinkingLevel ?? spaceDefaultEffort(undefined, supportedThinking);
  const unavailableDefault = metadata ? spaceDefaultUnavailable(metadata) : false;
  const needsConnection = Boolean(selectedModel && !selectedModel.credentialId);
  const unavailableSelection =
    needsConnection ||
    (modelMetaReady &&
      modelUnavailable({ catalog, credentials }, selectedModel?.provider, selectedModel?.modelId));

  const activeValidationError = runtimeKind === "hermes" ? validationError : null;
  const hermesRefusal =
    runtimeKind === "hermes"
      ? hermesConnectionRefusal(selectedModel?.provider, effectiveCredential)
      : undefined;

  async function executeSave(patchOverrides?: {
    name?: string;
    title?: string;
    description?: string;
    color?: string;
    notifyOnFinish?: boolean;
  }) {
    if (activeValidationError) return;
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
      const saved = await onSave({
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
        expectedModelPinRevision: draftPinRevision,
        ...(runtimeKind === "hermes" && runtimeConfig?.version === 2 ? { runtimeConfig } : {}),
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
      if (
        saved &&
        typeof saved === "object" &&
        "modelPinRevision" in saved &&
        typeof saved.modelPinRevision === "number"
      ) {
        setDraftPinRevision(saved.modelPinRevision);
        setSeededBot((prev) => ({
          ...prev,
          ...(saved as Partial<Bot>),
          modelPinRevision: saved.modelPinRevision,
        }));
      }
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
    <div data-testid="bot-settings" className="@container">
      <div className="flex justify-center py-4">
        <AvatarStudioPopover
          value={color}
          identity={bot.id}
          label={name}
          status={bot.status}
          size={76}
          onChange={(newColor) => {
            setColor(newColor);
            void enqueueSave({ color: newColor });
          }}
        />
      </div>
      <SettingsGroup label={t`Profile`}>
        <div className="grid gap-x-4 pb-4 @min-[480px]:grid-cols-2">
          <label htmlFor={`${ids}-name`} className={fieldLabelClass}>
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
          <label
            htmlFor={`${ids}-description`}
            className={`${fieldLabelClass} @min-[480px]:col-span-2`}
          >
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
        </div>
      </SettingsGroup>
      <SettingsGroup label={t`Model`}>
        <div className="pb-4">
          <div ref={runtimeRef}>
            <RuntimeSettings
              botId={bot.id}
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
          {runtimeKind === "hermes" ? (
            <p className="mt-2 text-sm text-muted-foreground">
              <Trans>Hermes runs with this computer's access.</Trans>
            </p>
          ) : null}
          {runtimeKind === "pi" || runtimeKind === "hermes" ? (
            <>
              <label htmlFor={`${ids}-model`} className={fieldLabelClass}>
                <Trans>Model</Trans>
                <ModelPinSelect
                  inputRef={attachModelRef}
                  id={`${ids}-model`}
                  settings={metadata}
                  showAll={showAllModels}
                  unavailableSelection={unavailableSelection}
                  needsConnection={needsConnection}
                  value={modelKey}
                  isCredentialDisabled={
                    runtimeKind === "hermes"
                      ? (credential) =>
                          Boolean(hermesConnectionRefusal(credential.provider, credential))
                      : undefined
                  }
                  onChange={(value) => {
                    setModelKey(value);
                    setThinkingLevel("");
                  }}
                  defaultLabel={
                    runtimeKind === "hermes"
                      ? t`Choose a model`
                      : `${t`Space default`}${
                          me?.defaultModel
                            ? ` (${catalogLabel(catalog, me.defaultProvider, me.defaultModel) ?? me.defaultModel}${unavailableDefault ? t` — not available on your account` : ""})`
                            : ""
                        }`
                  }
                />
              </label>
              {catalog.some(
                (entry) =>
                  credentials.some((credential) => credential.provider === entry.provider) &&
                  unavailableSubscriptionModel(catalog, entry.provider, entry.id),
              ) ? (
                <ShowAllModels checked={showAllModels} onChange={setShowAllModels} />
              ) : null}
              {!needsConnection &&
              (modelKey ? unavailableSelection : runtimeKind === "pi" && unavailableDefault) ? (
                <p className="mt-2 text-[12px] text-muted-foreground">
                  <Trans>This model is not available on your account. Choose another model.</Trans>
                </p>
              ) : null}
              <ModelEffortSelect
                id={`${ids}-thinking`}
                value={thinkingLevel}
                onChange={setThinkingLevel}
                supported={supportedThinking}
                isOllama={isOllama}
                defaultLevel={defaultThinkingLevel}
                notApplicable={isOllama && effectiveEntry?.reasoning === false}
              />
              {runtimeKind === "hermes" ? (
                <>
                  {hermesRefusal ? (
                    <p role="status" className="mt-2 text-sm text-muted-foreground">
                      {hermesRefusalMessage(hermesRefusal)}
                    </p>
                  ) : null}
                  <Suspense fallback={null}>
                    <RuntimeConfigPanel
                      value={runtimeConfig}
                      pin={{
                        runtimeKind: "hermes",
                        provider: selectedModel?.provider ?? null,
                        modelId: selectedModel?.modelId ?? null,
                        effort: thinkingLevel || null,
                        credentialId: selectedModel?.credentialId ?? null,
                      }}
                      onChange={setRuntimeConfig}
                      onError={setValidationError}
                      onOpenLearning={() => {
                        setAdvancedOpened(true);
                        setKnowledgeTab("learning");
                        if (advancedDetailsRef.current) advancedDetailsRef.current.open = true;
                        knowledgeRef.current?.scrollIntoView({ block: "nearest" });
                      }}
                    />
                  </Suspense>
                </>
              ) : null}
            </>
          ) : null}
          {(bot.groupModelOverrideCount ?? 0) > 0 ? (
            <details className="mt-3 text-sm text-muted-foreground">
              <summary className="cursor-pointer">
                <Plural
                  value={bot.groupModelOverrideCount ?? 0}
                  one="Also set differently in # group"
                  other="Also set differently in # groups"
                />
              </summary>
              <div className="mt-1 flex flex-wrap gap-2">
                {overrideGroups
                  .filter((group) =>
                    group.members.some(
                      (member) => member.botId === bot.id && member.runtimePin != null,
                    ),
                  )
                  .map((group) => (
                    <button
                      key={group.id}
                      type="button"
                      className="underline"
                      onClick={() => onOpenGroup?.(group.id)}
                    >
                      {group.name}
                    </button>
                  ))}
              </div>
            </details>
          ) : null}
          <div ref={destinationsRef} className="mt-4">
            <ModelDestinations botId={bot.id} />
          </div>
          <BotContext botId={bot.id} />
        </div>
      </SettingsGroup>
      <SettingsGroup label={t`Where this bot runs`}>
        <div ref={computerRef} className="space-y-3 py-4">
          <BotRuntimeSettings botId={bot.id} name={bot.name} mode={computerMode} />
          <ComputerModePicker value={computerMode} onChange={setComputerMode} />
          {computerMode === "team" ? (
            <p className="text-sm text-muted-foreground">
              <Trans>Bots share files and installed tools</Trans>
            </p>
          ) : null}
        </div>
      </SettingsGroup>
      <SettingsGroup label={t`Notifications`}>
        <div className="flex items-center justify-between gap-4 py-4">
          <span id={`${ids}-notify-finish-label`} className="text-[14px] text-foreground">
            <Trans>Get notified when this Bot finishes or needs input</Trans>
          </span>
          <Switch
            id={`${ids}-notify-finish`}
            checked={notifyOnFinish}
            aria-labelledby={`${ids}-notify-finish-label`}
            onCheckedChange={(checked) => {
              setNotifyOnFinish(checked);
              void enqueueSave({ notifyOnFinish: checked });
            }}
          />
        </div>
        <label
          htmlFor={`${ids}-auto-speak`}
          className="flex cursor-pointer items-center justify-between gap-4 border-t border-border py-4 text-[14px] text-foreground"
        >
          <Trans>Read replies aloud</Trans>
          <Switch
            id={`${ids}-auto-speak`}
            checked={autoSpeak}
            onCheckedChange={(checked) => setAutoSpeak(checked)}
          />
        </label>
        {voices.length ? (
          <label
            htmlFor={`${ids}-voice`}
            className="block border-t border-border py-4 text-[14px] text-muted-foreground"
          >
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
      </SettingsGroup>
      <details
        ref={advancedDetailsRef}
        data-testid="bot-settings-advanced"
        className="group"
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
        <div className="mt-4">
          <SettingsGroup label={t`Memory`}>
            <div className="pb-4">
              <Suspense fallback={null}>
                <ScratchpadSection botId={bot.id} />
                {advancedOpened ? (
                  <div ref={knowledgeRef}>
                    <KnowledgeSection
                      botId={bot.id}
                      onSkillsChange={onSkillsChange}
                      defaultTab={knowledgeTab}
                    />
                  </div>
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
            </div>
          </SettingsGroup>
        </div>
      </details>
      {error ? <p className="mt-2 text-[13px] text-destructive">{error}</p> : null}
      {needsConnection ? (
        <p className="mt-2 text-[12px] text-muted-foreground">
          <Trans>This bot's connection needs to be chosen. Pick the connection to use.</Trans>
        </p>
      ) : null}
      <div className="mt-5 flex flex-col items-start gap-3">
        <Button
          disabled={saving || Boolean(activeValidationError)}
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
          onPointerEnter={() => void import("./dialogs")}
          onFocus={() => void import("./dialogs")}
          onPointerDown={() => void import("./dialogs")}
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
