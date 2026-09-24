import type { ModelOAuthBegin, RuntimeAvailability, RuntimeKind } from "@ardurbot/contracts";
import { modelPinOptionKey, parseModelPinOptionKey } from "@ardurbot/core";
import { Button, NativeSelect, NativeSelectOption, Switch } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useId, useState } from "react";
import { rpc } from "../../lib/rpc";

export function RuntimeSettings({
  kind,
  onKind,
  modelKey,
  onModel,
  effort,
  onEffort,
  experimental,
  onExperimental,
}: {
  experimental: boolean;
  onExperimental: (enabled: boolean) => void;
  kind: RuntimeKind;
  onKind: (kind: RuntimeKind) => void;
  modelKey: string;
  onModel: (value: string) => void;
  effort: string;
  onEffort: (value: string) => void;
}) {
  const { t } = useLingui();
  const id = useId();
  const [availability, setAvailability] = useState<RuntimeAvailability | null>(null);
  const [login, setLogin] = useState<ModelOAuthBegin | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    setAvailability(null);
    setError(null);
    if (kind === "pi") return;
    let active = true;
    void rpc.runtimes
      .availability({ runtimeKind: kind })
      .then((value) => {
        if (active) setAvailability(value);
      })
      .catch(() => {
        if (active) setError(t`Runtime availability could not be checked.`);
      });
    return () => {
      active = false;
    };
  }, [kind, refresh]);
  useEffect(() => {
    if (!login) return;
    const timer = setInterval(() => {
      void rpc.runtimes
        .connectStatus({ loginId: login.loginId })
        .then((result) => {
          if (result.status === "ready") {
            setLogin(null);
            setRefresh((value) => value + 1);
          }
          if (result.status === "error") {
            setError(result.error);
            setLogin(null);
          }
        })
        .catch(() => {
          setError(t`Sign-in expired. Connect Codex again.`);
          setLogin(null);
        });
    }, 1_000);
    return () => {
      clearInterval(timer);
      void rpc.runtimes.cancelConnect({ loginId: login.loginId }).catch(() => undefined);
    };
  }, [login]);
  const selected = parseModelPinOptionKey(modelKey);
  const model = availability?.models.find((entry) => entry.id === selected?.modelId);
  return (
    <div className="mt-5 space-y-2">
      <label htmlFor={`${id}-runtime`} className="block text-[13.5px] text-muted-foreground">
        <Trans>Runs on</Trans>
      </label>
      <NativeSelect
        id={`${id}-runtime`}
        value={kind}
        onChange={(event) => {
          onKind(event.target.value as RuntimeKind);
          onExperimental(false);
          onModel("");
          onEffort("");
          setError(null);
          setLogin(null);
        }}
      >
        <NativeSelectOption value="pi">{t`Ardur (built-in)`}</NativeSelectOption>
        <NativeSelectOption value="claude-code">{t`Claude Code (your claude sign-in)`}</NativeSelectOption>
        <NativeSelectOption value="codex-app-server">{t`Codex (your ChatGPT sign-in)`}</NativeSelectOption>
      </NativeSelect>
      {kind !== "pi" ? (
        <>
          <label htmlFor={`${id}-experimental`} className="flex items-center gap-2">
            <Switch
              id={`${id}-experimental`}
              checked={experimental}
              onCheckedChange={onExperimental}
              aria-label={t`Experimental`}
            />
            <Trans>Experimental</Trans>
          </label>
          {availability ? (
            <p role="status" className="text-sm text-muted-foreground">
              {[
                availability.version,
                availability.signedIn === true
                  ? t`Signed in`
                  : availability.available
                    ? t`Available`
                    : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          ) : null}
          {availability?.reason ? (
            <p role="status" className="text-sm text-muted-foreground">
              {availability.reason}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button variant="ghost" size="sm" onClick={() => setRefresh((value) => value + 1)}>
            <Trans>Check again</Trans>
          </Button>
          {kind === "codex-app-server" && availability?.signedIn === false ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void rpc.runtimes
                  .connectCodex()
                  .then(setLogin)
                  .catch(() => setError(t`Codex app-server unavailable`));
              }}
            >
              <Trans>Connect</Trans>
            </Button>
          ) : null}
          {login ? (
            <div role="status" className="rounded-lg border p-3">
              <a
                href={login.verificationUri}
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                <Trans>Continue with ChatGPT</Trans>
              </a>
            </div>
          ) : null}
          <label htmlFor={`${id}-model`} className="block text-sm">
            <Trans>Model</Trans>
          </label>
          <NativeSelect
            id={`${id}-model`}
            value={selected?.modelId ?? ""}
            onChange={(event) => {
              const next = availability?.models.find((entry) => entry.id === event.target.value);
              onModel(
                next
                  ? modelPinOptionKey(
                      kind === "claude-code" ? "anthropic" : "openai-codex",
                      next.id,
                      `native:${kind}`,
                    )
                  : "",
              );
              onEffort("");
            }}
          >
            <NativeSelectOption value="">{t`Choose a model`}</NativeSelectOption>
            {selected?.modelId && !model ? (
              <NativeSelectOption value={selected.modelId}>
                {selected.modelId} — {t`not available`}
              </NativeSelectOption>
            ) : null}
            {availability?.models.map((entry) => (
              <NativeSelectOption key={entry.id} value={entry.id}>
                {entry.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <label htmlFor={`${id}-effort`} className="block text-sm">
            <Trans>Thinking</Trans>
          </label>
          <NativeSelect
            id={`${id}-effort`}
            value={effort}
            onChange={(event) => onEffort(event.target.value)}
          >
            <NativeSelectOption value="">{t`Choose effort`}</NativeSelectOption>
            {effort && !model?.efforts.includes(effort) ? (
              <NativeSelectOption value={effort}>
                {effort} — {t`not available`}
              </NativeSelectOption>
            ) : null}
            {model?.efforts.map((value) => (
              <NativeSelectOption key={value} value={value}>
                {value}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <p className="text-sm text-muted-foreground">
            {kind === "claude-code"
              ? t`Claude Code runs on host computers for now — change the bot's computer or its runtime.`
              : t`Codex runs on host computers for now — change the bot's computer or its runtime.`}
          </p>
        </>
      ) : null}
    </div>
  );
}
