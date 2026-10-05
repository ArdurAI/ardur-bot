import { RuntimePinSchema } from "@ardurbot/contracts";
import type {
  HermesRuntimeConfigV2,
  HistoricalHermesRuntimeConfig,
} from "@ardurbot/contracts/runtime-config";
import type { RuntimePin } from "@ardurbot/contracts/runtime-pins";
import { rpcErrorMessage } from "@ardurbot/core";
import { effectiveHermesRuntimeConfigV2 } from "@ardurbot/core/runtime-config";
import { Button, Input } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { lazy, Suspense, useEffect, useId, useRef, useState } from "react";
import { hermesContextMessage } from "../../lib/hermes-refusal";
import { rpc } from "../../lib/rpc";

const RuntimeConfigAdvanced = lazy(() => import("./runtime-config-advanced"));

export interface RuntimeConfigPanelProps {
  value: HistoricalHermesRuntimeConfig | null;
  onChange: (value: HermesRuntimeConfigV2) => void;
  onError?: (error: string | null) => void;
  onOpenLearning?: () => void;
  pin?: Partial<RuntimePin> | null;
  checkPin?: boolean;
}

export function RuntimeConfigPanel({
  value,
  onChange,
  onError,
  onOpenLearning,
  pin,
  checkPin = true,
}: RuntimeConfigPanelProps) {
  const id = useId();
  const { t } = useLingui();
  const settings = effectiveHermesRuntimeConfigV2(value);

  const [calls, setCalls] = useState(String(settings.limits.maxProviderRequests));
  const [time, setTime] = useState(String(settings.limits.timeoutMs / 1_000));
  const [contextKib, setContextKib] = useState(String(settings.context.maxInputBytes / 1_024));

  const [pinError, setPinError] = useState<string | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  // Translated at render so the extractor sees the macro; the effect reads the latest text.
  const checkFailed = t`Could not check the model. Try again.`;
  const checkFailedRef = useRef(checkFailed);
  checkFailedRef.current = checkFailed;
  const pinKey = JSON.stringify(pin ?? null);
  useEffect(() => {
    let active = true;
    setPinError(null);
    const choice = RuntimePinSchema.omit({ revision: true }).safeParse(JSON.parse(pinKey));
    if (checkPin && choice.success && choice.data.runtimeKind === "hermes") {
      void rpc.models
        .validatePin({ ...choice.data, computerLocation: "host", runtimeExperimental: true })
        .then(
          () => {
            if (active) setPinError(null);
          },
          (error: { code?: string; message: string }) => {
            if (active)
              setPinError(hermesContextMessage(rpcErrorMessage(error, checkFailedRef.current)));
          },
        );
    }
    return () => {
      active = false;
    };
  }, [pinKey, checkPin]);

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

  useEffect(() => {
    onErrorRef.current?.(pinError || callsError || timeError || contextError || advancedError);
  }, [pinError, callsError, timeError, contextError, advancedError]);

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
  };

  const handleCallsChange = (val: string) => {
    setCalls(val);
    const num = Number(val);
    if (!Number.isInteger(num) || num < 1 || num > 64) {
      updateErrors(t`Use a whole number from 1 to 64.`, timeError, contextError, advancedError);
      return;
    }
    const updated = {
      ...settings,
      limits: { ...settings.limits, maxProviderRequests: num },
    };
    onChange(updated);
    updateErrors(null, timeError, contextError, advancedError);
  };

  const handleTimeChange = (val: string) => {
    setTime(val);
    const num = Number(val);
    if (!Number.isInteger(num)) {
      updateErrors(callsError, t`Use whole seconds.`, contextError, advancedError);
      return;
    }
    if (num < 1 || num > 600) {
      updateErrors(callsError, t`Use a whole number from 1 to 600.`, contextError, advancedError);
      return;
    }
    const updated = {
      ...settings,
      limits: { ...settings.limits, timeoutMs: num * 1_000 },
    };
    onChange(updated);
    updateErrors(callsError, null, contextError, advancedError);
  };

  const handleContextChange = (val: string) => {
    setContextKib(val);
    const num = Number(val);
    if (!Number.isInteger(num)) {
      updateErrors(callsError, timeError, t`Use whole KiB.`, advancedError);
      return;
    }
    if (num < 4 || num > 64) {
      updateErrors(callsError, timeError, t`Use a whole number from 4 to 64.`, advancedError);
      return;
    }
    const updated = {
      ...settings,
      context: { ...settings.context, maxInputBytes: num * 1_024 },
    };
    onChange(updated);
    updateErrors(callsError, timeError, null, advancedError);
  };

  // Advanced errors render in place inside the editor while it is open; when the
  // section is closed the panel's visible error area must still explain why Save
  // is disabled. Short-panel errors render next to their own field and are linked
  // to it with aria-invalid and aria-describedby.
  const hiddenAdvancedError = !advancedOpen ? advancedError : null;

  return (
    <div className="mt-3 space-y-3" data-testid="runtime-config-panel">
      {pinError ? (
        <p role="alert" className="text-sm text-destructive">
          {pinError}
        </p>
      ) : null}
      <div className="grid grid-cols-3 gap-3">
        <label htmlFor={`${id}-calls`} className="text-sm text-muted-foreground">
          <Trans>Model calls per turn</Trans>
          <Input
            id={`${id}-calls`}
            type="number"
            min={1}
            max={64}
            step={1}
            value={calls}
            disabled={advancedInvalid}
            aria-invalid={callsError ? true : undefined}
            aria-describedby={callsError ? `${id}-calls-error` : undefined}
            onChange={(e) => handleCallsChange(e.target.value)}
          />
          {callsError ? (
            <p role="alert" id={`${id}-calls-error`} className="mt-1 text-xs text-destructive">
              {callsError}
            </p>
          ) : null}
        </label>
        <label htmlFor={`${id}-time`} className="text-sm text-muted-foreground">
          <Trans>Time limit (seconds)</Trans>
          <Input
            id={`${id}-time`}
            type="number"
            min={1}
            max={600}
            step={1}
            value={time}
            disabled={advancedInvalid}
            aria-invalid={timeError ? true : undefined}
            aria-describedby={timeError ? `${id}-time-error` : undefined}
            onChange={(e) => handleTimeChange(e.target.value)}
          />
          {timeError ? (
            <p role="alert" id={`${id}-time-error`} className="mt-1 text-xs text-destructive">
              {timeError}
            </p>
          ) : null}
        </label>
        <label htmlFor={`${id}-context`} className="text-sm text-muted-foreground">
          <Trans>Context limit (KiB)</Trans>
          <Input
            id={`${id}-context`}
            type="number"
            min={4}
            max={64}
            step={1}
            value={contextKib}
            disabled={advancedInvalid}
            aria-invalid={contextError ? true : undefined}
            aria-describedby={contextError ? `${id}-context-error` : undefined}
            onChange={(e) => handleContextChange(e.target.value)}
          />
          {contextError ? (
            <p role="alert" id={`${id}-context-error`} className="mt-1 text-xs text-destructive">
              {contextError}
            </p>
          ) : null}
        </label>
      </div>

      {advancedInvalid ? (
        <p
          data-testid="runtime-config-panel-advanced-hint"
          className="text-xs text-muted-foreground"
        >
          <Trans>Fix the configuration JSON to edit these settings.</Trans>
        </p>
      ) : null}

      {hiddenAdvancedError ? (
        <p
          role="alert"
          data-testid="runtime-config-panel-error"
          className="text-xs text-destructive"
        >
          {hiddenAdvancedError}
        </p>
      ) : null}

      <div className="flex items-center justify-between">
        {onOpenLearning ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onOpenLearning}
            className="-ms-2 text-xs text-muted-foreground hover:text-foreground"
          >
            <Trans>Learning</Trans>
          </Button>
        ) : null}
      </div>

      <details
        className="group mt-2 border-t border-border pt-2"
        onToggle={(event) => {
          const open = event.currentTarget.open;
          setAdvancedOpen(open);
          if (open) setAdvancedMounted(true);
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
        {advancedMounted ? (
          <Suspense fallback={null}>
            <RuntimeConfigAdvanced
              value={settings}
              pin={pin}
              onChange={(next) => {
                onChange(next);
                updateErrors(null, null, null, null);
              }}
              onError={(err) => {
                setAdvancedError(err);
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
          </Suspense>
        ) : null}
      </details>
    </div>
  );
}
export default RuntimeConfigPanel;
