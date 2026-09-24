import type { OllamaPullProgress, OllamaStatus } from "@ardurbot/contracts";
import { ollamaModelLabel } from "@ardurbot/contracts";
import { Button, Input, NativeSelect, NativeSelectOption } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useId, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { LoadingState } from "./ai/primitives";

export function OllamaSettings({
  onChanged,
  onReady,
}: {
  onChanged: () => Promise<void>;
  onReady?: () => void;
}) {
  const { t } = useLingui();
  const id = useId();
  const [status, setStatus] = useState<OllamaStatus | null>(null);
  const [url, setUrl] = useState("");
  const [model, setModel] = useState("");
  const [pullName, setPullName] = useState("qwen3:0.6b");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<OllamaPullProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const operation = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void rpc.models
      .ollama(undefined, { signal: controller.signal })
      .then((state) => {
        if (controller.signal.aborted) return;
        setStatus(state);
        setUrl(state.baseUrl);
        setModel(state.models[0]?.id ?? "");
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(t`Could not load Ollama.`);
      });
    return () => {
      controller.abort();
      operation.current?.abort();
    };
  }, []);

  async function run(action: (signal: AbortSignal) => Promise<void>) {
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError(null);
    try {
      await action(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted)
        setError(error instanceof Error ? error.message : t`Could not complete the request.`);
    } finally {
      if (operation.current === controller) {
        operation.current = null;
        setBusy(false);
        setProgress(null);
      }
    }
  }
  const tested = Boolean(
    status?.version && !status.issue && status.baseUrl === url.trim().replace(/\/$/, ""),
  );
  const saved = Boolean(status?.credentialId && tested);
  const percent = progress?.total
    ? Math.min(100, Math.round((100 * (progress.completed ?? 0)) / progress.total))
    : undefined;
  return (
    <div className="space-y-4">
      <label htmlFor={`${id}-url`} className="block text-sm">
        <Trans>Server URL</Trans>
        <Input
          id={`${id}-url`}
          aria-label={t`Ollama server URL`}
          value={url}
          disabled={busy}
          onChange={(event) => {
            setUrl(event.target.value);
            setError(null);
          }}
          className="mt-2"
        />
      </label>
      <div className="flex gap-2">
        <Button
          variant="outline"
          disabled={busy || !url.trim()}
          onClick={() =>
            void run(async (signal) => {
              const state = await rpc.models.testOllama({ baseUrl: url }, { signal });
              if (signal.aborted) return;
              setStatus({
                ...state,
                credentialId: state.baseUrl === status?.baseUrl ? status.credentialId : undefined,
              });
              setUrl(state.baseUrl);
              setModel(state.models[0]?.id ?? "");
            })
          }
        >
          <Trans>Test</Trans>
        </Button>
        <Button
          disabled={busy || !tested}
          onClick={() =>
            void run(async (signal) => {
              const connection = await rpc.models.connect(
                { provider: "ollama", baseUrl: url, modelId: model || undefined },
                { signal },
              );
              if (signal.aborted) return;
              setStatus((state) => (state ? { ...state, credentialId: connection.id } : state));
              await onChanged();
              if (model && !signal.aborted) onReady?.();
            })
          }
        >
          <Trans>Save</Trans>
        </Button>
      </div>
      {error || status?.issue ? (
        <p role="alert" className="text-sm text-destructive">
          {error ?? status?.issue}
        </p>
      ) : null}
      {status?.version ? (
        <p className="text-sm text-muted-foreground">Ollama {status.version}</p>
      ) : null}
      {tested && !status?.models.length ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>No models installed. Pull one to start.</Trans>
        </p>
      ) : null}
      {status?.models.length ? (
        <label htmlFor={`${id}-model`} className="block text-sm">
          <Trans>Installed models</Trans>
          <NativeSelect
            id={`${id}-model`}
            value={model}
            disabled={busy}
            onChange={(event) => setModel(event.target.value)}
            className="mt-2 w-full"
          >
            {status.models.map((entry) => (
              <NativeSelectOption key={entry.id} value={entry.id}>
                {ollamaModelLabel(entry)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
      ) : null}
      {saved && model ? (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            void run(async (signal) => {
              await rpc.models.setDefault({ provider: "ollama", modelId: model }, { signal });
              await onChanged();
              if (!signal.aborted) onReady?.();
            })
          }
        >
          <Trans>Use this model</Trans>
        </Button>
      ) : null}
      {status?.canPull && saved ? (
        <details>
          <summary className="cursor-pointer text-sm">
            <Trans>Pull model</Trans>
          </summary>
          <label htmlFor={`${id}-pull`} className="mt-3 block text-sm">
            <Trans>Model name</Trans>
          </label>
          <Input
            id={`${id}-pull`}
            value={pullName}
            list={`${id}-suggestions`}
            disabled={busy}
            onChange={(event) => setPullName(event.target.value)}
            className="mt-2"
          />
          <datalist id={`${id}-suggestions`}>
            <option value="qwen3:0.6b" />
            <option value="llama3.2:1b" />
          </datalist>
          <Button
            className="mt-2"
            disabled={busy || !pullName.trim()}
            onClick={() =>
              void run(async (signal) => {
                setProgress({ status: "pulling manifest" });
                const stream = await rpc.models.pullOllama({ model: pullName }, { signal });
                for await (const next of stream) {
                  if (!signal.aborted) setProgress(next);
                }
                if (signal.aborted) return;
                const state = await rpc.models.ollama(undefined, { signal });
                setStatus(state);
                setModel(
                  state.models.find((entry) => entry.id === pullName)?.id ??
                    state.models[0]?.id ??
                    "",
                );
                await onChanged();
              })
            }
          >
            <Trans>Pull</Trans>
          </Button>
        </details>
      ) : null}
      {busy ? (
        <div role="status" className="space-y-2">
          <LoadingState
            label={
              progress
                ? `${progress.status}${percent === undefined ? "" : ` · ${percent}%`}`
                : t`Checking…`
            }
          />
          <Button variant="ghost" onClick={() => operation.current?.abort()}>
            <Trans>Cancel</Trans>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
