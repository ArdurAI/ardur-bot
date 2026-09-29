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
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, Pressable, Text, TextInput, View } from "react-native";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

/** Same messages as the web Advanced editor; mobile resolves them through its own catalog. */
export function runtimeConfigIssueMessage(
  issue: RuntimeConfigIssue,
  t: (message: string) => string,
): string {
  switch (issue.code) {
    case "invalid-json":
      return t("Enter valid JSON.");
    case "duplicate-key":
      return t("Remove the duplicate field.");
    case "document-too-large":
      return t("Configuration must be 16 KiB or smaller.");
    case "too-deep":
    case "too-many-members":
      return t("This configuration is too complex.");
    case "unsupported-version":
    case "unsupported-runtime":
      return t("This configuration version is not supported.");
    case "unknown-field":
    case "prototype-key":
      return t("This field is not supported.");
    case "managed-model":
      return t("Ardur sets the model and thinking level. Change them in bot settings.");
    case "managed-connection":
      return t("Use Ardur Connections for provider settings.");
    case "managed-tools":
      return t("Use Ardur settings for tools, integrations, MCP servers, skills, and plugins.");
    case "managed-policy":
    case "forbidden-path":
      return t("Ardur manages paths, hooks, permissions, and network access.");
    case "forbidden-code-loading":
      return t("Runtime settings cannot install or load code.");
    case "native-learning-unavailable":
      return t("Use Ardur Learning settings.");
    case "native-children-unavailable":
      return t("Native child agents are not available with Hermes.");
    case "native-compression-unavailable":
      return t("Native compression is not available with Hermes.");
    case "out-of-range": {
      if (issue.path === "limits.maxProviderRequests") return t("Use a whole number from 1 to 64.");
      if (issue.path === "limits.timeoutMs") return t("Use whole seconds.");
      if (issue.path === "context.maxInputBytes") return t("Use whole KiB.");
      if (issue.path === "context.overflow") return t("Choose Trim older context or Stop the run.");
      if (issue.path === "harness.agent.api_max_retries")
        return t("Use a whole number from 1 to 3.");
      return t("Use a whole number from 1 to 64.");
    }
    default:
      return t("This field is not supported.");
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
  const { t } = useI18n();
  const tokens = useMobileTokens();

  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [issues, setIssues] = useState<RuntimeConfigIssue[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  const [preview, setPreview] = useState<HermesRuntimeConfigPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const editorRef = useRef<TextInput>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const tRef = useRef(t);
  tRef.current = t;

  const latestRequestId = useRef(0);

  const fetchPreview = useCallback(async (doc: HermesRuntimeConfigV2Draft) => {
    const currentPin = pinRef.current;
    const reqId = ++latestRequestId.current;
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const res = await rpc<{
        preview?: HermesRuntimeConfigPreview;
        issues: RuntimeConfigIssue[];
      }>("runtimeConfig/preview", {
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
        const msg = runtimeConfigIssueMessage(res.issues[0]!, tRef.current);
        setPreviewError(msg);
        onErrorRef.current(msg);
      } else if (res.preview) {
        setPreview(res.preview);
        setPreviewError(null);
      }
    } catch {
      if (latestRequestId.current !== reqId) return;
      setPreviewError(tRef.current("Could not preview the configuration. Try again."));
    } finally {
      if (latestRequestId.current === reqId) {
        setPreviewLoading(false);
      }
    }
  }, []);

  // Sync incoming value from the short panel when editor text is valid. While
  // the text is invalid the editor owns the draft: skip the update without
  // advancing lastSyncValue so a later fix cannot silently replace an
  // intervening change.
  const lastSyncValue = useRef(value);
  useEffect(() => {
    if (localError !== null) return;
    if (JSON.stringify(lastSyncValue.current) === JSON.stringify(value)) return;
    lastSyncValue.current = value;
    setText(JSON.stringify(value, null, 2));
  }, [value, localError]);

  // Initial preview fetch, and again when the pin changes.
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
      const msg = runtimeConfigIssueMessage(parsed.issues[0]!, t);
      setIssues(parsed.issues);
      setLocalError(msg);
      onInvalidChange?.(true);
      onError(msg);
      return;
    }
    setIssues([]);
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
    setIssues([]);
    setLocalError(null);
    onInvalidChange?.(false);
    setPreviewError(null);
    lastSyncValue.current = defaults;
    onReset();
    void fetchPreview(defaults);
  };

  // Move the caret to the field the first reported issue points at.
  const focusIssue = () => {
    const input = editorRef.current as unknown as {
      focus?: () => void;
      setSelection?: (start: number, end: number) => void;
    } | null;
    const range = issues[0]?.range;
    input?.focus?.();
    if (range) input?.setSelection?.(range.start, range.end);
  };

  const fallbackEffective = effectiveHermesRuntimeConfigV2(value);
  const effective = preview?.settings ?? fallbackEffective;

  const field = { color: tokens.foreground } as const;
  const label = { color: tokens.mutedForeground, fontSize: 12 } as const;

  return (
    <View style={{ gap: 12, marginTop: 12 }}>
      <View>
        <Text style={label}>{t("Configuration (JSON)")}</Text>
        <TextInput
          ref={editorRef}
          accessibilityLabel={t("Configuration (JSON)")}
          value={text}
          onChangeText={handleTextChange}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          style={{
            marginTop: 8,
            minHeight: 200,
            textAlignVertical: "top",
            borderWidth: 1,
            borderColor: localError ? tokens.destructive : tokens.border,
            borderRadius: 11,
            padding: 12,
            color: tokens.foreground,
            fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
            fontSize: 12,
          }}
        />
        {localError ? (
          <Pressable accessibilityRole="button" onPress={focusIssue}>
            <Text accessibilityRole="alert" style={{ color: tokens.destructive, marginTop: 8 }}>
              {localError}
            </Text>
          </Pressable>
        ) : null}
        <Pressable accessibilityRole="button" onPress={handleReset} style={{ marginTop: 8 }}>
          <Text style={{ color: tokens.mutedForeground }}>{t("Reset to defaults")}</Text>
        </Pressable>
      </View>

      <View
        style={{
          borderWidth: 1,
          borderColor: tokens.border,
          borderRadius: 11,
          padding: 12,
          gap: 10,
        }}
      >
        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <Text style={{ color: tokens.foreground, fontWeight: "500" }}>
            {t("Effective configuration")}
          </Text>
          {previewLoading ? (
            <Text style={{ color: tokens.mutedForeground, fontSize: 12 }}>{t("Loading…")}</Text>
          ) : null}
        </View>

        {previewError ? (
          <View style={{ gap: 8 }}>
            <Text accessibilityRole="alert" style={{ color: tokens.destructive, fontSize: 12 }}>
              {previewError}
            </Text>
            {previewError === t("Could not preview the configuration. Try again.") ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  const parsed = parseRuntimeConfigText(text);
                  void fetchPreview(parsed.success ? parsed.document : value);
                }}
              >
                <Text style={{ color: tokens.foreground }}>{t("Try again")}</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        <View style={{ gap: 4, borderTopWidth: 1, borderTopColor: tokens.border, paddingTop: 8 }}>
          <Text style={{ color: tokens.mutedForeground, fontSize: 12, fontWeight: "600" }}>
            {t("Your settings")}
          </Text>
          <Text style={label}>
            {t("Model calls per turn")}:{" "}
            <Text style={field}>{effective.limits.maxProviderRequests}</Text>
          </Text>
          <Text style={label}>
            {t("Time limit (seconds)")}:{" "}
            <Text style={field}>{effective.limits.timeoutMs / 1_000}</Text>
          </Text>
          <Text style={label}>
            {t("Context limit (KiB)")}:{" "}
            <Text style={field}>{effective.context.maxInputBytes / 1_024}</Text>
          </Text>
          <Text style={label}>
            {t("When context is full")}:{" "}
            <Text style={field}>
              {effective.context.overflow === "trim" ? t("Trim older context") : t("Stop the run")}
            </Text>
          </Text>
          <Text style={label}>
            {t("API attempts")}:{" "}
            <Text style={field}>{effective.harness.agent.api_max_retries}</Text>
          </Text>
        </View>

        <View style={{ gap: 4, borderTopWidth: 1, borderTopColor: tokens.border, paddingTop: 8 }}>
          <Text style={{ color: tokens.mutedForeground, fontSize: 12, fontWeight: "600" }}>
            {t("Ardur manages")}
          </Text>
          <Text style={{ color: tokens.mutedForeground, fontSize: 12 }}>
            {t("Model, thinking, connections, tools, and permissions come from Ardur.")}
          </Text>
          <Text style={label}>
            {t("Child agents")}: <Text style={field}>{t("Unavailable with Hermes.")}</Text>
          </Text>
          <Text style={label}>
            {t("Native compression")}: <Text style={field}>{t("Off")}</Text>
          </Text>
        </View>
      </View>
    </View>
  );
}
export default RuntimeConfigAdvanced;
