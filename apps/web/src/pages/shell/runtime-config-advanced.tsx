import type {
  HermesRuntimeConfigPreview,
  HermesRuntimeConfigV2,
  HermesRuntimeConfigV2Draft,
  RuntimeConfigIssue,
} from "@ardurbot/contracts/runtime-config";
import { HERMES_RUNTIME_V2_DEFAULTS } from "@ardurbot/contracts/runtime-config";
import { parseRuntimeConfigText } from "@ardurbot/contracts/runtime-config-editor";
import type { RuntimePin } from "@ardurbot/contracts/runtime-pins";
import {
  effectiveHermesRuntimeConfigV2,
  normalizeHermesRuntimeConfig,
} from "@ardurbot/core/runtime-config";
import { Button, Textarea } from "@ardurbot/ui-web";
import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";

export function runtimeConfigIssueMessage(issue: RuntimeConfigIssue): string {
  switch (issue.code) {
    case "invalid-json":
      return t`Enter valid JSON.`;
    case "duplicate-key":
      return t`Remove the duplicate field.`;
    case "document-too-large":
      return t`Configuration must be 16 KiB or smaller.`;
    case "too-deep":
    case "too-many-members":
      return t`This configuration is too complex.`;
    case "unsupported-version":
    case "unsupported-runtime":
      return t`This configuration version is not supported.`;
    case "unknown-field":
    case "prototype-key":
      return t`This field is not supported.`;
    case "managed-model":
      return t`Ardur sets the model and thinking level. Change them in bot settings.`;
    case "managed-connection":
      return t`Use Ardur Connections for provider settings.`;
    case "managed-tools":
      return t`Use Ardur settings for tools, integrations, MCP servers, skills, and plugins.`;
    case "managed-policy":
    case "forbidden-path":
      return t`Ardur manages paths, hooks, permissions, and network access.`;
    case "forbidden-code-loading":
      return t`Runtime settings cannot install or load code.`;
    case "native-learning-unavailable":
      return t`Use Ardur Learning settings.`;
    case "native-children-unavailable":
      return t`Native child agents are not available with Hermes.`;
    case "native-compression-unavailable":
      return t`Native compression is not available with Hermes.`;
    case "out-of-range": {
      if (issue.path === "limits.maxProviderRequests") return t`Use a whole number from 1 to 64.`;
      if (issue.path === "limits.timeoutMs") return t`Use whole seconds.`;
      if (issue.path === "context.maxInputBytes") return t`Use whole KiB.`;
      if (issue.path === "context.overflow") return t`Choose Trim older context or Stop the run.`;
      if (issue.path === "harness.agent.api_max_retries") return t`Use a whole number from 1 to 3.`;
      return t`Use a whole number from 1 to 64.`;
    }
    default:
      return t`This field is not supported.`;
  }
}

export interface RuntimeConfigAdvancedProps {
  value: HermesRuntimeConfigV2Draft | HermesRuntimeConfigV2;
  pin?: Partial<RuntimePin> | null;
  onChange: (value: HermesRuntimeConfigV2) => void;
  onError: (error: string | null) => void;
  onReset: () => void;
  onInvalidChange?: (invalid: boolean) => void;
}

export function RuntimeConfigAdvanced({
  value,
  pin,
  onChange,
  onError,
  onReset,
  onInvalidChange,
}: RuntimeConfigAdvancedProps) {
  const { t } = useLingui();
  const id = useId();

  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [localError, setLocalError] = useState<string | null>(null);
  const [preview, setPreview] = useState<HermesRuntimeConfigPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const pinRef = useRef(pin);
  pinRef.current = pin;

  const latestRequestId = useRef(0);

  const fetchPreview = useCallback(async (doc: HermesRuntimeConfigV2Draft) => {
    const currentPin = pinRef.current;
    const reqId = ++latestRequestId.current;
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const res = await rpc.runtimeConfig.preview({
        runtimeKind: "hermes",
        runtimeConfig: doc,
        pin: {
          runtimeKind: "hermes",
          provider: currentPin?.provider ?? null,
          modelId: currentPin?.modelId ?? null,
          effort: currentPin?.effort ?? null,
          credentialId: currentPin?.credentialId ?? null,
        },
      });
      if (latestRequestId.current !== reqId) return;
      if (res.issues && res.issues.length > 0) {
        const msg = runtimeConfigIssueMessage(res.issues[0]!);
        setPreviewError(msg);
        onErrorRef.current(msg);
      } else if (res.preview) {
        setPreview(res.preview);
        setPreviewError(null);
      }
    } catch {
      if (latestRequestId.current !== reqId) return;
      setPreviewError(t`Could not preview the configuration. Try again.`);
    } finally {
      if (latestRequestId.current === reqId) {
        setPreviewLoading(false);
      }
    }
    // t is captured from the first render; the i18n instance is stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync incoming value from short-panel when editor text is valid. While the
  // text is invalid the editor owns the draft: skip the update without advancing
  // lastSyncValue so a later fix cannot silently replace an intervening change.
  const lastSyncValue = useRef(value);
  useEffect(() => {
    if (localError !== null) return;
    if (JSON.stringify(lastSyncValue.current) === JSON.stringify(value)) return;
    lastSyncValue.current = value;
    setText(JSON.stringify(value, null, 2));
  }, [value, localError]);

  // Initial preview fetch or when pin changes
  useEffect(() => {
    const parsed = parseRuntimeConfigText(text);
    if (parsed.success) {
      void fetchPreview(parsed.document);
    }
  }, [pin?.provider, pin?.modelId, pin?.credentialId, pin?.effort, fetchPreview]);

  const handleTextChange = (newText: string) => {
    setText(newText);
    const parsed = parseRuntimeConfigText(newText);
    if (!parsed.success) {
      const msg = runtimeConfigIssueMessage(parsed.issues[0]!);
      setLocalError(msg);
      onInvalidChange?.(true);
      onError(msg);
      return;
    }
    setLocalError(null);
    onInvalidChange?.(false);
    const normalized = normalizeHermesRuntimeConfig(parsed.document);
    lastSyncValue.current = normalized;
    onChange(normalized);
    onError(null);
    void fetchPreview(parsed.document);
  };

  const handleReset = () => {
    const defaults = HERMES_RUNTIME_V2_DEFAULTS;
    const formatted = JSON.stringify(defaults, null, 2);
    setText(formatted);
    setLocalError(null);
    onInvalidChange?.(false);
    setPreviewError(null);
    lastSyncValue.current = defaults;
    onReset();
    void fetchPreview(defaults);
  };

  const fallbackEffective = effectiveHermesRuntimeConfigV2(value);
  const effective = preview?.settings ?? fallbackEffective;

  return (
    <div className="mt-3 space-y-4" data-testid="runtime-config-advanced">
      <div>
        <label htmlFor={`${id}-json`} className="block text-sm text-muted-foreground">
          <Trans>Configuration (JSON)</Trans>
        </label>
        <Textarea
          id={`${id}-json`}
          aria-label={t`Configuration (JSON)`}
          aria-invalid={localError ? true : undefined}
          aria-describedby={localError ? `${id}-json-error` : undefined}
          value={text}
          onChange={(e) => handleTextChange(e.target.value)}
          className="mt-2 font-mono text-xs leading-relaxed"
          rows={10}
          spellCheck={false}
        />
        {localError ? (
          <p
            role="alert"
            id={`${id}-json-error`}
            data-testid="runtime-config-advanced-error"
            className="mt-2 text-xs text-destructive"
          >
            {localError}
          </p>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          onClick={handleReset}
          className="mt-2 text-xs text-muted-foreground"
        >
          <Trans>Reset to defaults</Trans>
        </Button>
      </div>

      <div
        className="rounded-lg border border-border p-3 space-y-3"
        data-testid="runtime-config-preview"
      >
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-medium text-foreground">
            <Trans>Effective configuration</Trans>
          </h4>
          {previewLoading ? (
            <span className="text-xs text-muted-foreground">
              <Trans>Loading…</Trans>
            </span>
          ) : null}
        </div>

        {previewError ? (
          <div className="space-y-2">
            <p role="alert" className="text-xs text-destructive">
              {previewError}
            </p>
            {previewError === t`Could not preview the configuration. Try again.` ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const parsed = parseRuntimeConfigText(text);
                  void fetchPreview(parsed.success ? parsed.document : value);
                }}
              >
                <Trans>Try again</Trans>
              </Button>
            ) : null}
          </div>
        ) : null}

        <div className="space-y-1.5 border-t border-border pt-2">
          <h5 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            <Trans>Your settings</Trans>
          </h5>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <div>
              <span className="text-muted-foreground">
                <Trans>Model calls per turn</Trans>:{" "}
              </span>
              <span className="font-mono" data-testid="preview-calls">
                {effective.limits.maxProviderRequests}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">
                <Trans>Time limit (seconds)</Trans>:{" "}
              </span>
              <span className="font-mono" data-testid="preview-time">
                {effective.limits.timeoutMs / 1_000}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">
                <Trans>Context limit (KiB)</Trans>:{" "}
              </span>
              <span className="font-mono" data-testid="preview-context">
                {effective.context.maxInputBytes / 1_024}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">
                <Trans>When context is full</Trans>:{" "}
              </span>
              <span className="font-medium" data-testid="preview-overflow">
                {effective.context.overflow === "trim" ? (
                  <Trans>Trim older context</Trans>
                ) : (
                  <Trans>Stop the run</Trans>
                )}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">
                <Trans>API attempts</Trans>:{" "}
              </span>
              <span className="font-mono" data-testid="preview-attempts">
                {effective.harness.agent.api_max_retries}
              </span>
            </div>
          </div>
        </div>

        <div className="space-y-1.5 border-t border-border pt-2">
          <h5 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            <Trans>Ardur manages</Trans>
          </h5>
          <p className="text-xs text-muted-foreground">
            <Trans>Model, thinking, connections, tools, and permissions come from Ardur.</Trans>
          </p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <div>
              <span className="text-muted-foreground">
                <Trans>Child agents</Trans>:{" "}
              </span>
              <span>
                <Trans>Unavailable with Hermes.</Trans>
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">
                <Trans>Native compression</Trans>:{" "}
              </span>
              <span>
                <Trans>Off</Trans>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
export default RuntimeConfigAdvanced;
