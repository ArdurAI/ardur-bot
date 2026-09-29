import type {
  HermesRuntimeConfigV2,
  HistoricalHermesRuntimeConfig,
} from "@ardurbot/contracts/runtime-config";
import type { RuntimePin } from "@ardurbot/contracts/runtime-pins";
import { effectiveHermesRuntimeConfigV2 } from "@ardurbot/core/runtime-config";
import { useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { RuntimeConfigAdvanced } from "./runtime-config-advanced";

export interface RuntimeConfigPanelProps {
  value: HistoricalHermesRuntimeConfig | null;
  onChange: (value: HermesRuntimeConfigV2) => void;
  onError?: (error: string | null) => void;
  onOpenLearning?: () => void;
  pin?: Partial<RuntimePin> | null;
}

export function RuntimeConfigPanel({
  value,
  onChange,
  onError,
  onOpenLearning,
  pin,
}: RuntimeConfigPanelProps) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const settings = effectiveHermesRuntimeConfigV2(value);

  const [calls, setCalls] = useState(String(settings.limits.maxProviderRequests));
  const [time, setTime] = useState(String(settings.limits.timeoutMs / 1_000));
  const [contextKib, setContextKib] = useState(String(settings.context.maxInputBytes / 1_024));

  const [callsError, setCallsError] = useState<string | null>(null);
  const [timeError, setTimeError] = useState<string | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  const [advancedError, setAdvancedError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advancedMounted, setAdvancedMounted] = useState(false);
  const [advancedInvalid, setAdvancedInvalid] = useState(false);

  useEffect(() => {
    setCalls(String(settings.limits.maxProviderRequests));
  }, [settings.limits.maxProviderRequests]);

  useEffect(() => {
    setTime(String(settings.limits.timeoutMs / 1_000));
  }, [settings.limits.timeoutMs]);

  useEffect(() => {
    setContextKib(String(settings.context.maxInputBytes / 1_024));
  }, [settings.context.maxInputBytes]);

  const updateErrors = (
    nextCallsErr: string | null,
    nextTimeErr: string | null,
    nextContextErr: string | null,
    nextAdvancedErr: string | null,
  ) => {
    setCallsError(nextCallsErr);
    setTimeError(nextTimeErr);
    setContextError(nextContextErr);
    setAdvancedError(nextAdvancedErr);
    const active = nextCallsErr || nextTimeErr || nextContextErr || nextAdvancedErr || null;
    onError?.(active);
  };

  const handleCallsChange = (val: string) => {
    setCalls(val);
    const num = Number(val);
    if (!Number.isInteger(num) || num < 1 || num > 64) {
      updateErrors(t("Use a whole number from 1 to 64."), timeError, contextError, advancedError);
      return;
    }
    onChange({
      ...settings,
      limits: { ...settings.limits, maxProviderRequests: num },
    });
    updateErrors(null, timeError, contextError, advancedError);
  };

  const handleTimeChange = (val: string) => {
    setTime(val);
    const num = Number(val);
    if (!Number.isInteger(num)) {
      updateErrors(callsError, t("Use whole seconds."), contextError, advancedError);
      return;
    }
    if (num < 1 || num > 600) {
      updateErrors(callsError, t("Use a whole number from 1 to 600."), contextError, advancedError);
      return;
    }
    onChange({
      ...settings,
      limits: { ...settings.limits, timeoutMs: num * 1_000 },
    });
    updateErrors(callsError, null, contextError, advancedError);
  };

  const handleContextChange = (val: string) => {
    setContextKib(val);
    const num = Number(val);
    if (!Number.isInteger(num)) {
      updateErrors(callsError, timeError, t("Use whole KiB."), advancedError);
      return;
    }
    if (num < 4 || num > 64) {
      updateErrors(callsError, timeError, t("Use a whole number from 4 to 64."), advancedError);
      return;
    }
    onChange({
      ...settings,
      context: { ...settings.context, maxInputBytes: num * 1_024 },
    });
    updateErrors(callsError, timeError, null, advancedError);
  };

  // Advanced errors render in place inside the editor while it is open; when
  // the section is closed the panel's visible error area must still explain
  // why Save is disabled.
  const hiddenAdvancedError = !advancedOpen ? advancedError : null;

  const input = {
    marginTop: 4,
    borderWidth: 1,
    borderColor: tokens.border,
    borderRadius: 11,
    padding: 12,
    color: tokens.foreground,
  } as const;

  return (
    <View style={{ gap: 12, marginTop: 12 }}>
      <View style={{ flexDirection: "row", gap: 12 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: tokens.mutedForeground }}>{t("Model calls per turn")}</Text>
          <TextInput
            accessibilityLabel={t("Model calls per turn")}
            keyboardType="number-pad"
            editable={!advancedInvalid}
            value={calls}
            onChangeText={handleCallsChange}
            style={[
              input,
              callsError ? { borderColor: tokens.destructive } : null,
              advancedInvalid ? { opacity: 0.4 } : null,
            ]}
          />
          {callsError ? (
            <Text
              accessibilityRole="alert"
              style={{ color: tokens.destructive, fontSize: 12, marginTop: 4 }}
            >
              {callsError}
            </Text>
          ) : null}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: tokens.mutedForeground }}>{t("Time limit (seconds)")}</Text>
          <TextInput
            accessibilityLabel={t("Time limit (seconds)")}
            keyboardType="number-pad"
            editable={!advancedInvalid}
            value={time}
            onChangeText={handleTimeChange}
            style={[
              input,
              timeError ? { borderColor: tokens.destructive } : null,
              advancedInvalid ? { opacity: 0.4 } : null,
            ]}
          />
          {timeError ? (
            <Text
              accessibilityRole="alert"
              style={{ color: tokens.destructive, fontSize: 12, marginTop: 4 }}
            >
              {timeError}
            </Text>
          ) : null}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: tokens.mutedForeground }}>{t("Context limit (KiB)")}</Text>
          <TextInput
            accessibilityLabel={t("Context limit (KiB)")}
            keyboardType="number-pad"
            editable={!advancedInvalid}
            value={contextKib}
            onChangeText={handleContextChange}
            style={[
              input,
              contextError ? { borderColor: tokens.destructive } : null,
              advancedInvalid ? { opacity: 0.4 } : null,
            ]}
          />
          {contextError ? (
            <Text
              accessibilityRole="alert"
              style={{ color: tokens.destructive, fontSize: 12, marginTop: 4 }}
            >
              {contextError}
            </Text>
          ) : null}
        </View>
      </View>

      {advancedInvalid ? (
        <Text style={{ color: tokens.mutedForeground, fontSize: 12 }}>
          {t("Fix the configuration JSON to edit these settings.")}
        </Text>
      ) : null}

      {hiddenAdvancedError ? (
        <Text accessibilityRole="alert" style={{ color: tokens.destructive, fontSize: 12 }}>
          {hiddenAdvancedError}
        </Text>
      ) : null}

      {onOpenLearning ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Learning")}
          onPress={onOpenLearning}
        >
          <Text style={{ color: tokens.mutedForeground }}>{t("Learning")}</Text>
        </Pressable>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("Advanced")}
        accessibilityState={{ expanded: advancedOpen }}
        onPress={() => {
          setAdvancedOpen((open) => {
            if (!open) setAdvancedMounted(true);
            return !open;
          });
        }}
        style={{
          minHeight: 44,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          borderTopWidth: 1,
          borderTopColor: tokens.border,
        }}
      >
        <Text style={{ color: tokens.mutedForeground, fontSize: 14 }}>{t("Advanced")}</Text>
        <Text style={{ color: tokens.mutedForeground, fontSize: 18 }}>
          {advancedOpen ? "⌃" : "⌄"}
        </Text>
      </Pressable>
      {advancedMounted && advancedOpen ? (
        <RuntimeConfigAdvanced
          value={settings}
          pin={pin}
          onChange={(next) => {
            onChange(next);
            updateErrors(null, null, null, null);
          }}
          onError={(err) => {
            setAdvancedError(err);
            const active = callsError || timeError || contextError || err || null;
            onError?.(active);
          }}
          onInvalidChange={setAdvancedInvalid}
          onReset={() => {
            const defaults = effectiveHermesRuntimeConfigV2(null);
            setCalls(String(defaults.limits.maxProviderRequests));
            setTime(String(defaults.limits.timeoutMs / 1_000));
            setContextKib(String(defaults.context.maxInputBytes / 1_024));
            onChange(defaults);
            updateErrors(null, null, null, null);
          }}
        />
      ) : null}
    </View>
  );
}
export default RuntimeConfigPanel;
