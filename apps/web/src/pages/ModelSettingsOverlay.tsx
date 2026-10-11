import type { Me, ModelContextWindowSource, ThinkingLevel } from "@ardurbot/contracts";
import {
  DEFAULT_CONNECTION_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_TOKENS,
  MAX_MODEL_CONTEXT_WINDOW,
  MAX_MODEL_MAX_TOKENS,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  openAiCompatibleConnectReady,
  openAiCompatibleProbeSuccessMessage,
  parseModelContextWindow,
  parseModelMaxImagesPerPrompt,
  parseModelMaxTokens,
} from "@ardurbot/contracts";
import type { ModelConnectionChoice } from "@ardurbot/core";
import {
  createModelProbe,
  initialModelProbeState,
  recommendedDefaultModelId,
} from "@ardurbot/core";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  ModelThinkingOptions,
  NativeSelect,
  NativeSelectOption,
} from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import CatalogModelPicker from "../components/CatalogModelPicker";
import { OllamaSettings } from "../components/OllamaSettings";
import type { ModelCatalogEntry, ModelCredential } from "../lib/model-auth";
import { modelContextLabel } from "../lib/model-context-label";
import { availableProviderModels } from "../lib/model-options";
import { modelSelectionErrorMessage } from "../lib/model-selection-error";
import { rpc } from "../lib/rpc";
import { thinkingLevelOptions } from "../lib/thinking-level-options";
import { useModelOAuthSignIn } from "../lib/use-model-oauth-signin";
import { NativeRuntimeSettings } from "./settings/NativeRuntimeSettings";

export function ModelSettingsOverlay({
  onClose,
  embedded = false,
  localOwner = false,
  initialProvider,
  onOpenBotRuntime,
  onSavePendingChange,
}: {
  onClose: () => void;
  /** Render panel body only for the shared Settings shell. */
  embedded?: boolean;
  localOwner?: boolean;
  initialProvider?: string;
  onOpenBotRuntime?: () => void;
  onSavePendingChange?: (pending: boolean) => void;
}) {
  const { t } = useLingui();
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  const [credentials, setCredentials] = useState<ModelCredential[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [provider, setProvider] = useState(initialProvider ?? "");
  const [credentialId, setCredentialId] = useState<string | undefined>();
  const [editingConnection, setEditingConnection] = useState(false);
  const [pickedEntry, setPickedEntry] = useState<ModelCatalogEntry | null>(null);
  const [modelId, setModelId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [reasoning, setReasoning] = useState(false);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel | null>(null);
  const [maxTokens, setMaxTokens] = useState(String(DEFAULT_MODEL_MAX_TOKENS));
  const [contextWindow, setContextWindow] = useState(String(DEFAULT_CONNECTION_CONTEXT_WINDOW));
  const [contextWindowSource, setContextWindowSource] =
    useState<ModelContextWindowSource>("default");
  const [contextWindowEdited, setContextWindowEdited] = useState(false);
  const [supportsImages, setSupportsImages] = useState(false);
  const [maxImagesPerPrompt, setMaxImagesPerPrompt] = useState("");
  const [{ models: probeModels, probing }, setProbe] = useState(initialModelProbeState);
  const [modelProbe] = useState(() => createModelProbe(setProbe));
  const resetOpenAiCompatibleProbe = modelProbe.reset;
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<"connect" | "default" | null>(null);
  const [oauthSaving, setOauthSaving] = useState(false);
  const [ollamaSaving, setOllamaSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const detailScrollRef = useRef<HTMLDivElement>(null);
  const refreshRevisionRef = useRef(0);
  const selectionRevisionRef = useRef(0);
  const selectedLabelRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    onSavePendingChange?.(pending !== null || oauthSaving || ollamaSaving);
  }, [onSavePendingChange, pending, oauthSaving, ollamaSaving]);

  const {
    oauth,
    pasteCode,
    setPasteCode,
    oauthPending,
    cancelOAuthAttempt,
    startSubscriptionSignIn,
    submitOAuthCode,
  } = useModelOAuthSignIn({
    onPersistenceChange: setOauthSaving,
    onClearError: () => setError(null),
    onError: setError,
    onFinished: async (controller) => {
      await refresh();
      if (controller.signal.aborted) return;
      setNotice(t`Connected and using ${selectedLabelRef.current ?? "this model"}.`);
    },
  });

  async function refresh() {
    const refreshRevision = ++refreshRevisionRef.current;
    const selectionRevision = selectionRevisionRef.current;
    const [nextCatalog, nextCredentials, nextMe] = await Promise.all([
      rpc.models.list(),
      rpc.models.credentials(),
      rpc.me(),
    ]);
    if (refreshRevision !== refreshRevisionRef.current) return;
    const nextProvider =
      provider && nextCatalog.some((entry) => entry.provider === provider)
        ? provider
        : (nextMe.defaultProvider ?? nextCatalog[0]?.provider ?? "");
    const nextCredential =
      nextCredentials.find(
        (entry) => entry.provider === nextProvider && entry.id === credentialId,
      ) ??
      nextCredentials.find((entry) => entry.provider === nextProvider && entry.isDefault) ??
      (nextCredentials.filter((entry) => entry.provider === nextProvider).length === 1
        ? nextCredentials.find((entry) => entry.provider === nextProvider)
        : undefined);
    const nextModels = availableProviderModels(nextCatalog, nextProvider);
    const nextModel =
      nextProvider === OPENAI_COMPATIBLE_PROVIDER_ID
        ? (nextCredential?.modelId ??
          (nextMe.defaultProvider === OPENAI_COMPATIBLE_PROVIDER_ID ? nextMe.defaultModel : "") ??
          "")
        : (nextCatalog.find((entry) => entry.provider === nextProvider && entry.id === modelId)
            ?.id ??
          nextModels.find((entry) => entry.id === nextMe.defaultModel)?.id ??
          recommendedDefaultModelId(
            nextProvider,
            nextModels.map((entry) => entry.id),
          ) ??
          "");
    setCatalog(nextCatalog);
    setCredentials(nextCredentials);
    setMe(nextMe);
    if (selectionRevision === selectionRevisionRef.current) {
      resetOpenAiCompatibleProbe();
      setProvider(nextProvider);
      setCredentialId(nextCredential?.id);
      setModelId(nextModel);
      if (nextProvider === OPENAI_COMPATIBLE_PROVIDER_ID) {
        setBaseUrl(nextCredential?.baseUrl ?? "");
        setReasoning(nextCredential?.reasoning ?? false);
        setThinkingLevel(nextCredential?.thinkingLevel ?? null);
        setMaxTokens(String(nextCredential?.maxTokens ?? DEFAULT_MODEL_MAX_TOKENS));
        setContextWindow(
          String(nextCredential?.contextWindow ?? DEFAULT_CONNECTION_CONTEXT_WINDOW),
        );
        setContextWindowSource(
          nextCredential?.contextWindowSource ??
            (nextCredential?.contextWindow ? "metadata" : "default"),
        );
        setContextWindowEdited(false);
        setSupportsImages(nextCredential?.supportsImages ?? false);
        setMaxImagesPerPrompt(String(nextCredential?.maxImagesPerPrompt ?? ""));
      }
    }
  }

  useEffect(() => {
    void refresh()
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : t`Could not load model settings`),
      )
      .finally(() => setLoading(false));
    return () => {
      refreshRevisionRef.current += 1;
      modelProbe.invalidate();
    };
  }, []);

  const modelsForProvider = availableProviderModels(catalog, provider);
  const recommendedId = recommendedDefaultModelId(
    provider,
    modelsForProvider.map((entry) => entry.id),
  );
  const selected =
    (pickedEntry?.provider === provider ? pickedEntry : undefined) ??
    catalog.find((entry) => entry.provider === provider && entry.id === modelId) ??
    modelsForProvider.find((entry) => entry.id === recommendedId);
  selectedLabelRef.current = selected?.label;
  const isOpenAiCompatible = provider === OPENAI_COMPATIBLE_PROVIDER_ID;
  const credential = credentials.find((entry) => entry.id === credentialId);
  const connectionReady = Boolean(
    credential?.hasKey && !credential.connectionIssue && !selected?.placeholder,
  );
  const currentEntry = catalog.find(
    (entry) => entry.provider === me?.defaultProvider && entry.id === me?.defaultModel,
  );
  const isActive =
    credential?.isDefault === true &&
    credential.connectionIssue === undefined &&
    me?.defaultProvider === selected?.provider &&
    me?.defaultModel === (isOpenAiCompatible ? modelId.trim() : selected?.id);
  const acceptsKey = selected?.auth !== "oauth";
  const subscriptionSignIn = selected?.signIn !== undefined;
  const busy = pending !== null || oauthPending;
  const effectiveBaseUrl = baseUrl.trim();
  const openAiCompatibleReady = openAiCompatibleConnectReady({
    baseUrl: effectiveBaseUrl,
    modelId,
  });

  function updateBaseUrl(nextBaseUrl: string) {
    setBaseUrl(nextBaseUrl);
    resetOpenAiCompatibleProbe();
    setError(null);
    setNotice(null);
  }

  function updateApiKey(nextApiKey: string) {
    setApiKey(nextApiKey);
    resetOpenAiCompatibleProbe();
  }

  function chooseProvider(nextProvider: string, nextCredential?: ModelCredential) {
    cancelOAuthAttempt();
    selectionRevisionRef.current += 1;
    setProvider(nextProvider);
    setCredentialId(nextCredential?.id);
    setReasoning(nextCredential?.reasoning ?? false);
    setThinkingLevel(nextCredential?.thinkingLevel ?? null);
    setMaxTokens(String(nextCredential?.maxTokens ?? DEFAULT_MODEL_MAX_TOKENS));
    setContextWindow(String(nextCredential?.contextWindow ?? DEFAULT_CONNECTION_CONTEXT_WINDOW));
    setContextWindowSource(
      nextCredential?.contextWindowSource ??
        (nextCredential?.contextWindow ? "metadata" : "default"),
    );
    setContextWindowEdited(false);
    setSupportsImages(nextCredential?.supportsImages ?? false);
    setMaxImagesPerPrompt(String(nextCredential?.maxImagesPerPrompt ?? ""));
    setModelId(
      nextProvider === OPENAI_COMPATIBLE_PROVIDER_ID
        ? (nextCredential?.modelId ?? "")
        : (recommendedDefaultModelId(
            nextProvider,
            availableProviderModels(catalog, nextProvider).map((entry) => entry.id),
          ) ?? ""),
    );
    setBaseUrl(
      nextProvider === OPENAI_COMPATIBLE_PROVIDER_ID ? (nextCredential?.baseUrl ?? "") : "",
    );
    detailScrollRef.current?.scrollTo({ top: 0 });
    setApiKey("");
    resetOpenAiCompatibleProbe();
    setError(null);
    setNotice(null);
  }

  function chooseModel(choice: ModelConnectionChoice | null) {
    chooseProvider(choice?.entry.provider ?? "", choice?.credential);
    setPickedEntry(choice?.entry ?? null);
    setEditingConnection(false);
    if (!choice) return;
    setModelId(choice.entry.placeholder ? "" : choice.entry.id);
    setCredentialId(choice.credential?.id);
    setBaseUrl(choice.credential?.baseUrl ?? "");
  }

  async function probeServerModels() {
    if (!baseUrl.trim()) return;
    setError(null);
    setNotice(null);
    await modelProbe.probe({
      baseUrl,
      apiKey,
      request: rpc.models.probeOpenAiCompatible,
      onSuccess: (models) => {
        setModelId((current) => current.trim() || models[0] || "");
        setNotice(openAiCompatibleProbeSuccessMessage(models.length));
      },
      onError: (err) =>
        setError(err instanceof Error ? err.message : t`Could not reach this model server`),
    });
  }

  async function setModelDefault() {
    if (!selected || !credential) return;
    const activeModelId = isOpenAiCompatible ? modelId.trim() : selected.id;
    if (isOpenAiCompatible && !activeModelId) return;
    setError(null);
    setNotice(null);
    setPending("default");
    try {
      await rpc.models.setDefault({
        provider: selected.provider,
        modelId: activeModelId,
        credentialId: credential.id,
      });
      await refresh();
      setNotice(isOpenAiCompatible ? t`Model updated.` : t`Now using ${selected.label}.`);
    } catch (err) {
      setError(modelSelectionErrorMessage(err, t`Could not change the default model`));
    } finally {
      setPending(null);
    }
  }

  async function connectKey() {
    if (!selected) return;
    if (isOpenAiCompatible) {
      if (!effectiveBaseUrl || !modelId.trim()) return;
    } else if (!apiKey.trim()) {
      return;
    }
    const parsedMaxImagesPerPrompt = parseModelMaxImagesPerPrompt(
      maxImagesPerPrompt,
      supportsImages,
    );
    if (supportsImages && maxImagesPerPrompt.trim() && parsedMaxImagesPerPrompt === undefined) {
      setError(t`Enter a whole number from 1 to 1000 for the image limit.`);
      return;
    }
    const maxImagesPerPromptInput =
      supportsImages && !maxImagesPerPrompt.trim() ? null : parsedMaxImagesPerPrompt;

    const parsedMaxTokens = parseModelMaxTokens(maxTokens);
    if (parsedMaxTokens === undefined) {
      setError(
        t`Enter a whole number from 1 to ${MAX_MODEL_MAX_TOKENS} for maximum output tokens.`,
      );
      return;
    }
    const parsedContextWindow = parseModelContextWindow(contextWindow);
    if (parsedContextWindow === undefined) {
      setError(
        t`Enter a whole number from 1 to ${MAX_MODEL_CONTEXT_WINDOW} for the context limit.`,
      );
      return;
    }
    setError(null);
    setNotice(null);
    setPending("connect");
    try {
      await rpc.models.connect(
        isOpenAiCompatible
          ? {
              provider: selected.provider,
              credentialId,
              baseUrl: effectiveBaseUrl,
              modelId: modelId.trim(),
              reasoning,
              thinkingLevel: reasoning ? thinkingLevel : null,
              maxTokens: parsedMaxTokens,
              ...(contextWindowEdited ? { contextWindow: parsedContextWindow } : {}),
              supportsImages,
              maxImagesPerPrompt: maxImagesPerPromptInput,
              apiKey: apiKey.trim() || undefined,
              label: credential?.label ?? selected.providerName ?? selected.provider,
            }
          : {
              provider: selected.provider,
              credentialId,
              apiKey: apiKey.trim(),
              modelId: selected.id,
              label: credential?.label ?? selected.providerName ?? selected.provider,
            },
      );
      setApiKey("");
      await refresh();
      detailScrollRef.current?.scrollTo({ top: 0 });
      setNotice(isOpenAiCompatible ? t`Saved.` : t`Connected and using ${selected.label}.`);
    } catch (err) {
      setError(modelSelectionErrorMessage(err, t`Could not connect this provider`));
    } finally {
      setPending(null);
    }
  }

  function handleClose() {
    cancelOAuthAttempt(false);
    onClose();
  }

  function beginSelectedSubscriptionSignIn() {
    if (!selected) return;
    setNotice(null);
    void startSubscriptionSignIn({
      provider: selected.provider,
      modelId: selected.id,
      label: selected.providerName ?? selected.provider,
    });
  }

  const description = loading ? (
    <Trans>Loading model catalog…</Trans>
  ) : localOwner ? (
    <Trans>Models for the server owner’s default space.</Trans>
  ) : (
    <Trans>Choose which connected model Ardur uses.</Trans>
  );

  const body = (
    <>
      {!embedded ? (
        <DialogHeader className="flex-row items-start justify-between px-6 pt-6 sm:px-8 sm:pt-7">
          <div>
            <DialogTitle className="text-2xl text-foreground">
              <Trans>Models</Trans>
            </DialogTitle>
            <DialogDescription className="mt-1 text-[13.5px] text-muted-foreground/70">
              {description}
            </DialogDescription>
          </div>
          <DialogClose
            render={<Button variant="ghost" size="icon-sm" aria-label={t`Close model settings`} />}
          >
            <X />
          </DialogClose>
        </DialogHeader>
      ) : (
        <p className="px-6 pt-1 text-[13.5px] text-muted-foreground/70 sm:px-8">{description}</p>
      )}

      <div
        className={`mx-6 rounded-xl border border-border px-4 py-3 sm:mx-8 ${embedded ? "mt-4" : "mt-5"}`}
      >
        <div className="text-[12.5px] uppercase tracking-[0.08em] text-muted-foreground/80">
          <Trans>Active model</Trans>
        </div>
        <div className="mt-1 break-all text-[16px] text-foreground">
          {currentEntry?.label ?? me?.defaultModel ?? t`Deployment default`}
        </div>
        <div className="mt-1 text-[13px] text-muted-foreground">
          {currentEntry?.providerName ?? me?.defaultProvider ?? (
            <Trans>Configured by deployment</Trans>
          )}
        </div>
      </div>

      {me ? <NativeRuntimeSettings canConnect={me.isDeploymentOwner === true} /> : null}

      <div className="flex min-w-0 flex-col gap-6 px-6 py-6 sm:px-8 @min-[44rem]:flex-row">
        <div className="min-w-0 flex-1">
          <CatalogModelPicker
            catalog={catalog}
            credentials={credentials}
            provider={provider}
            modelId={modelId}
            credentialId={credentialId}
            onChange={chooseModel}
            disabled={pending !== null || oauthSaving || ollamaSaving}
          />
        </div>

        <div ref={detailScrollRef} className="min-w-0 flex-1">
          {error ? <p className="mb-4 text-sm text-destructive">{error}</p> : null}
          {notice ? <p className="mb-4 text-sm text-success">{notice}</p> : null}
          {connectionReady && !editingConnection ? (
            <div className="space-y-3">
              <Button disabled={busy || isActive} onClick={() => void setModelDefault()}>
                <Trans>Use this model</Trans>
              </Button>
              {!credential?.oauth ? (
                <Button variant="outline" onClick={() => setEditingConnection(true)}>
                  <Trans>Connection settings</Trans>
                </Button>
              ) : null}
            </div>
          ) : provider === "ollama" ? (
            <OllamaSettings
              credentialId={credentialId}
              modelId={modelId || undefined}
              onChanged={refresh}
              onSavePendingChange={setOllamaSaving}
            />
          ) : selected ? (
            <>
              <div className="block text-[13.5px] text-muted-foreground">
                {isOpenAiCompatible ? (
                  <>
                    <label className="block" htmlFor="model-base-url">
                      <Trans>Server URL</Trans>
                      <Input
                        id="model-base-url"
                        value={baseUrl}
                        onChange={(event) => updateBaseUrl(event.target.value)}
                        aria-label={t`OpenAI-compatible server URL`}
                        placeholder="http://127.0.0.1:8000/v1"
                        autoComplete="off"
                        className="mt-2 h-10 text-foreground"
                      />
                    </label>
                    <details className="mt-2 text-[13px] leading-[1.5] text-muted-foreground">
                      <summary className="w-fit cursor-pointer select-none">
                        <Trans>Setup help</Trans>
                      </summary>
                      <p className="mt-1">
                        {t`Paste the OpenAI-compatible address from your server. Ardur adds /v1 if needed.`}
                      </p>
                    </details>
                    <div className="mt-3 flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy || probing || !effectiveBaseUrl}
                        onClick={() => void probeServerModels()}
                      >
                        {probing ? <Trans>Finding…</Trans> : <Trans>Find models</Trans>}
                      </Button>
                    </div>
                    <div className="mt-4 block">
                      <span>
                        <Trans>Model</Trans>
                      </span>
                      {probeModels.length && probeModels.includes(modelId) ? (
                        <NativeSelect
                          className="mt-2 w-full text-foreground"
                          value={modelId}
                          onChange={(event) => {
                            cancelOAuthAttempt();
                            selectionRevisionRef.current += 1;
                            setModelId(event.target.value);
                            setError(null);
                            setNotice(null);
                          }}
                          aria-label={t`Models from server`}
                        >
                          {probeModels.map((id) => (
                            <NativeSelectOption key={id} value={id}>
                              {id}
                            </NativeSelectOption>
                          ))}
                          <NativeSelectOption value="">
                            <Trans>Other model…</Trans>
                          </NativeSelectOption>
                        </NativeSelect>
                      ) : (
                        <Input
                          value={modelId}
                          onChange={(event) => {
                            cancelOAuthAttempt();
                            selectionRevisionRef.current += 1;
                            setModelId(event.target.value);
                            setError(null);
                            setNotice(null);
                          }}
                          aria-label={t`Model id`}
                          placeholder="exact-model-id"
                          className="mt-2 h-10 text-foreground"
                        />
                      )}
                      {probeModels.length && !probeModels.includes(modelId) ? (
                        <Button
                          type="button"
                          variant="link"
                          className="mt-2 h-auto px-0 text-[13px] text-muted-foreground underline"
                          onClick={() => setModelId(probeModels[0] ?? "")}
                        >
                          <Trans>Use a found model</Trans>
                        </Button>
                      ) : null}
                    </div>
                    <ModelThinkingOptions
                      reasoning={reasoning}
                      onReasoningChange={(value) => {
                        selectionRevisionRef.current += 1;
                        setReasoning(value);
                        if (!value) setThinkingLevel(null);
                        setNotice(null);
                      }}
                      disabled={busy}
                      advancedLabel={t`Advanced`}
                      thinkingLabel={t`Supports thinking`}
                      thinkingLevel={thinkingLevel}
                      onThinkingLevelChange={(value) => {
                        selectionRevisionRef.current += 1;
                        setThinkingLevel(value as ThinkingLevel | null);
                        setNotice(null);
                      }}
                      thinkingLevelOptions={thinkingLevelOptions()}
                      thinkingLevelLabel={t`Reasoning effort`}
                      thinkingLevelDefaultLabel={t`Default`}
                      maxTokens={maxTokens}
                      onMaxTokensChange={(value) => {
                        selectionRevisionRef.current += 1;
                        setMaxTokens(value);
                        setNotice(null);
                      }}
                      maxTokensLabel={t`Maximum output tokens`}
                      contextWindow={contextWindow}
                      onContextWindowChange={(value) => {
                        selectionRevisionRef.current += 1;
                        setContextWindow(value);
                        setContextWindowEdited(true);
                        setNotice(null);
                      }}
                      contextWindowLabel={modelContextLabel(
                        contextWindowEdited ? "metadata" : contextWindowSource,
                      )}
                      supportsImages={supportsImages}
                      onSupportsImagesChange={(value) => {
                        selectionRevisionRef.current += 1;
                        setSupportsImages(value);
                        setNotice(null);
                      }}
                      imagesLabel={t`Supports images`}
                      maxImagesPerPrompt={maxImagesPerPrompt}
                      onMaxImagesPerPromptChange={(value) => {
                        selectionRevisionRef.current += 1;
                        setMaxImagesPerPrompt(value);
                        setNotice(null);
                      }}
                      maxImagesLabel={t`Maximum images per request`}
                    />
                  </>
                ) : selected?.contextWindow ? (
                  <p className="text-sm text-muted-foreground">
                    {modelContextLabel("catalog")}: {selected.contextWindow.toLocaleString()}
                  </p>
                ) : null}
              </div>
              {!isOpenAiCompatible && selected.billing ? (
                <p className="mt-2 text-[13px] leading-[1.5] text-muted-foreground">
                  {provider === "anthropic" ? (
                    <Trans>Set up on the home device</Trans>
                  ) : (
                    selected.billing
                  )}
                </p>
              ) : null}

              {provider === "anthropic" && onOpenBotRuntime ? (
                <Button variant="outline" onClick={onOpenBotRuntime}>
                  <Trans>Open bot settings</Trans>
                </Button>
              ) : null}
              {!isOpenAiCompatible ? (
                <div className="mt-5 rounded-xl border border-border px-4 py-3">
                  <div className="text-[12.5px] uppercase tracking-[0.08em] text-muted-foreground/80">
                    <Trans>Personal credential</Trans>
                  </div>
                  <div className="mt-1 text-[15px] text-foreground">
                    {credential?.connectionIssue === "api-key-required" ? (
                      <Trans>Reconnect with an API key</Trans>
                    ) : credential ? (
                      <Trans>Connected · {credential.label}</Trans>
                    ) : (
                      <Trans>Not connected</Trans>
                    )}
                  </div>
                  <div className="mt-1 text-[13px] text-muted-foreground">
                    {credential?.connectionIssue ? null : credential ? (
                      <Trans>Stored securely. Never shown here.</Trans>
                    ) : (
                      <Trans>Connect this provider to use it as your personal model.</Trans>
                    )}
                  </div>
                </div>
              ) : null}

              {subscriptionSignIn ? (
                <div className="mt-5">
                  {oauth ? (
                    <div className="rounded-xl border border-border px-4 py-3">
                      {oauth.mode === "auth-url" ? (
                        <>
                          <p className="text-sm leading-[1.5] text-muted-foreground">
                            <Trans>
                              Finish signing in at{" "}
                              <a
                                href={oauth.verificationUri}
                                target="_blank"
                                rel="noreferrer"
                                className="text-foreground underline"
                              >
                                {new URL(oauth.verificationUri).hostname}
                              </a>
                              . The final page may not load; paste its URL or code here.
                            </Trans>
                          </p>
                          <div className="mt-3 flex items-center gap-2">
                            <Input
                              value={pasteCode}
                              onChange={(e) => setPasteCode(e.target.value)}
                              aria-label={t`Authorization code or callback URL`}
                              autoComplete="off"
                              spellCheck={false}
                              placeholder="http://localhost:53692/callback?code=…"
                              className="text-foreground md:text-[13px]"
                            />
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={!pasteCode.trim()}
                              onClick={() => void submitOAuthCode()}
                            >
                              <Trans>Submit</Trans>
                            </Button>
                          </div>
                          <p className="mt-2 text-sm text-muted-foreground">
                            <Trans>Waiting for sign-in…</Trans>
                          </p>
                        </>
                      ) : (
                        <>
                          <p className="text-sm leading-[1.5] text-muted-foreground">
                            <Trans>
                              Enter this code at{" "}
                              <a
                                href={oauth.verificationUri}
                                target="_blank"
                                rel="noreferrer"
                                className="text-foreground underline"
                              >
                                {oauth.verificationUri.replace(/^https:\/\//, "")}
                              </a>
                            </Trans>
                          </p>
                          <p className="mt-2 font-mono text-[22px] tracking-[0.2em] text-foreground">
                            {oauth.userCode}
                          </p>
                          <p className="mt-2 text-sm text-muted-foreground">
                            <Trans>Waiting for sign-in…</Trans>
                          </p>
                        </>
                      )}
                    </div>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => beginSelectedSubscriptionSignIn()}
                    >
                      {oauthPending ? (
                        <Trans>Starting…</Trans>
                      ) : (
                        (selected.oauthLabel ?? t`Sign in`)
                      )}
                    </Button>
                  )}
                </div>
              ) : null}

              {acceptsKey ? (
                <div className="mt-5">
                  {isOpenAiCompatible ? (
                    <details className="text-[13.5px] text-muted-foreground">
                      <summary className="w-fit cursor-pointer select-none">
                        <Trans>API key</Trans>
                      </summary>
                      <Input
                        aria-label={t`API key`}
                        value={apiKey}
                        onChange={(event) => updateApiKey(event.target.value)}
                        placeholder={t`Optional`}
                        type="password"
                        autoComplete="new-password"
                        className="mt-2 h-10 text-foreground"
                      />
                    </details>
                  ) : (
                    <label
                      className="block text-[13.5px] text-muted-foreground"
                      htmlFor="model-api-key"
                    >
                      {credential?.hasKey ? (
                        <Trans>Replace API key</Trans>
                      ) : subscriptionSignIn ? (
                        <Trans>Or connect an API key</Trans>
                      ) : (
                        <Trans>API key</Trans>
                      )}
                      <Input
                        id="model-api-key"
                        value={apiKey}
                        onChange={(event) => updateApiKey(event.target.value)}
                        placeholder="sk-…"
                        type="password"
                        autoComplete="new-password"
                        className="mt-2 h-10 text-foreground"
                      />
                    </label>
                  )}
                  <Button
                    type="button"
                    variant="secondary"
                    className="mt-3 rounded-full"
                    size="sm"
                    disabled={
                      busy ||
                      (isOpenAiCompatible ? !openAiCompatibleReady : apiKey.trim().length < 8)
                    }
                    onClick={() => void connectKey()}
                  >
                    {pending === "connect" ? (
                      <Trans>Saving…</Trans>
                    ) : isOpenAiCompatible ? (
                      <Trans>Save</Trans>
                    ) : credential?.hasKey ? (
                      <Trans>Replace API key</Trans>
                    ) : (
                      <Trans>Connect API key</Trans>
                    )}
                  </Button>
                </div>
              ) : null}

              {selected.auth === "oauth" && !subscriptionSignIn ? (
                <p className="mt-5 text-sm leading-[1.5] text-muted-foreground">
                  <Trans>
                    This subscription sign-in is not available in Ardur yet. Use a deployment
                    credential or choose another provider.
                  </Trans>
                </p>
              ) : null}

              {credential?.hasKey && !isActive ? (
                <div className="mt-6">
                  <Button
                    type="button"
                    variant="secondary"
                    className="rounded-full"
                    size="sm"
                    disabled={busy || (isOpenAiCompatible && !modelId.trim())}
                    onClick={() => void setModelDefault()}
                  >
                    {pending === "default" ? (
                      <Trans>Switching…</Trans>
                    ) : (
                      <Trans>Use this model</Trans>
                    )}
                  </Button>
                </div>
              ) : null}
            </>
          ) : loading ? (
            <p className="text-muted-foreground">
              <Trans>Loading model catalog…</Trans>
            </p>
          ) : !provider ? null : (
            <p className="text-muted-foreground">
              <Trans>No model catalog is available.</Trans>
            </p>
          )}
        </div>
      </div>
    </>
  );

  if (embedded) {
    return (
      <div data-testid="model-settings" className="flex min-w-0 flex-col">
        {body}
      </div>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="@container flex h-[760px] max-h-[calc(100%-2rem)] w-[1080px] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-y-auto rounded-2xl bg-card p-0 sm:max-w-[1080px]"
      >
        {body}
      </DialogContent>
    </Dialog>
  );
}
