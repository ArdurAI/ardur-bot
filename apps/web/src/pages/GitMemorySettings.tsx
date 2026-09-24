import type { MemoryImportPreview, MemorySyncState, SpaceMemoryConfig } from "@ardurbot/contracts";
import { Button, Input, NativeSelect, NativeSelectOption, Textarea } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useId, useState } from "react";
import { downloadArtifactBytes } from "../lib/artifact-open";
import { rpc } from "../lib/rpc";

export function GitMemoryStatus() {
  const { t } = useLingui();
  const [state, setState] = useState<MemorySyncState | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    const load = () =>
      rpc.memory
        .syncState()
        .then((value) => {
          if (active) setState(value);
        })
        .catch(() => {
          if (active) setError(true);
        });
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  async function retry() {
    setBusy(true);
    try {
      await rpc.memory.retrySync();
      setError(false);
      setState((current) => (current ? { ...current, status: "pending" } : null));
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  async function review() {
    setBusy(true);
    try {
      const bundle = await rpc.memory.export();
      downloadArtifactBytes(
        "memory-review.json",
        "application/json",
        new TextEncoder().encode(JSON.stringify(bundle, null, 2)),
      );
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  const message = error
    ? t`Could not load sync status. Retry.`
    : state?.status === "failed"
      ? t`Saved locally. GitHub sync failed.`
      : state?.status === "last-copy"
        ? t`Working from the last copy`
        : state?.status === "quarantined"
          ? t`Repository history changed. Review the saved copy before continuing.`
          : state?.status === "pending"
            ? t`Saved locally. Sync pending.`
            : null;
  return (
    <div className="mt-2 space-y-2 text-sm text-muted-foreground" aria-live="polite">
      {message ? <p>{message}</p> : null}
      {error || state?.status === "failed" || state?.status === "last-copy" ? (
        <Button variant="outline" disabled={busy} onClick={() => void retry()}>
          <Trans>Retry</Trans>
        </Button>
      ) : null}
      {state?.status === "quarantined" ? (
        <Button variant="outline" disabled={busy} onClick={() => void review()}>
          <Trans>Review saved copy</Trans>
        </Button>
      ) : null}
      {state?.proposalBranch ? (
        <details>
          <summary>
            <Trans>Proposal branch</Trans>
          </summary>
          <p className="break-all font-mono text-xs">{state.proposalBranch}</p>
        </details>
      ) : null}
    </div>
  );
}
export function GitMemorySettings({
  config,
  onConfigChange,
  onBusyChange,
}: {
  config: SpaceMemoryConfig | null | undefined;
  onConfigChange(config: SpaceMemoryConfig): void;
  onBusyChange(busy: boolean): void;
}) {
  const { t } = useLingui();
  const urlId = useId();
  const branchId = useId();
  const settings = config?.documentStore === "git" ? config.documentSettings : {};
  const [url, setUrl] = useState(settings.url ?? "");
  const [branch, setBranch] = useState(settings.branch ?? "main");
  const [mode, setMode] = useState<"publish" | "propose">(
    settings.mode === "propose" ? "propose" : "publish",
  );
  const [kind, setKind] = useState<"token" | "ssh">(
    settings.url?.startsWith("ssh:") ? "ssh" : "token",
  );
  const [credential, setCredential] = useState("");
  const [preview, setPreview] = useState<(MemoryImportPreview & { connectionId: string }) | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  function changed() {
    setPreview(null);
    setError(null);
  }
  async function submit(confirm: boolean) {
    setBusy(true);
    onBusyChange(true);
    setError(null);
    try {
      const result = await rpc.memory.gitLocation({
        url,
        branch,
        mode,
        expectedGeneration: config?.generation ?? 0,
        ...(credential ? { credential: { kind, value: credential } } : {}),
        ...(preview ? { connectionId: preview.connectionId } : {}),
        ...(confirm && preview ? { expectedHash: preview.hash } : {}),
      });
      setCredential("");
      if (result.config) {
        onConfigChange(result.config);
        setPreview(null);
      } else setPreview(result);
    } catch {
      setCredential("");
      setPreview(null);
      setError(t`Could not connect the repository. Check its URL and access, then retry.`);
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }
  return (
    <div className="mt-4 space-y-3" data-testid="git-memory-settings">
      <label htmlFor={urlId} className="block text-sm">
        <Trans>Repository URL</Trans>
        <Input
          id={urlId}
          aria-label={t`Repository URL`}
          value={url}
          disabled={busy}
          onChange={(event) => {
            setUrl(event.target.value);
            setKind(event.target.value.startsWith("ssh:") ? "ssh" : "token");
            changed();
          }}
          placeholder="https://github.com/owner/memory.git"
        />
      </label>
      <label htmlFor={branchId} className="block text-sm">
        <Trans>Branch</Trans>
        <Input
          id={branchId}
          aria-label={t`Branch`}
          value={branch}
          disabled={busy}
          onChange={(event) => {
            setBranch(event.target.value);
            changed();
          }}
        />
      </label>
      <NativeSelect
        aria-label={t`Publication mode`}
        value={mode}
        disabled={busy}
        onChange={(event) => {
          setMode(event.target.value as "publish" | "propose");
          changed();
        }}
      >
        <NativeSelectOption value="publish">
          <Trans>Publish directly</Trans>
        </NativeSelectOption>
        <NativeSelectOption value="propose">
          <Trans>Propose on a branch</Trans>
        </NativeSelectOption>
      </NativeSelect>
      <NativeSelect
        aria-label={t`Repository authentication`}
        value={kind}
        disabled={busy}
        onChange={(event) => {
          setKind(event.target.value as "token" | "ssh");
          setCredential("");
          changed();
        }}
      >
        <NativeSelectOption value="token">
          <Trans>Repository token</Trans>
        </NativeSelectOption>
        <NativeSelectOption value="ssh">
          <Trans>Deploy private key</Trans>
        </NativeSelectOption>
      </NativeSelect>
      {kind === "token" ? (
        <Input
          aria-label={t`Repository token`}
          type="password"
          autoComplete="new-password"
          value={credential}
          disabled={busy}
          onChange={(event) => {
            setCredential(event.target.value);
            changed();
          }}
        />
      ) : (
        <Textarea
          aria-label={t`Deploy private key`}
          autoComplete="off"
          spellCheck={false}
          value={credential}
          disabled={busy}
          onChange={(event) => {
            setCredential(event.target.value);
            changed();
          }}
        />
      )}
      <p className="text-xs text-muted-foreground">
        <Trans>Only space-shared documents go to this repository.</Trans>
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button
        variant="outline"
        disabled={
          busy || !url || !branch || (!credential && config?.documentStore !== "git" && !preview)
        }
        onClick={() => void submit(false)}
      >
        <Trans>Test connection and preview</Trans>
      </Button>
      {preview ? (
        <div className="space-y-2 text-sm">
          <p>
            <Trans>
              {preview.documents} documents, {preview.revisions} revisions
            </Trans>
          </p>
          <p>
            {mode === "propose"
              ? t`Shared recall will use proposed facts after merge.`
              : t`Shared documents will be published directly.`}
          </p>
          {preview.conflicts.map((conflict) => (
            <p key={conflict.id} className="text-destructive">
              <Trans>Conflict: {conflict.path}</Trans>
            </p>
          ))}
          <Button disabled={busy || preview.conflicts.length > 0} onClick={() => void submit(true)}>
            <Trans>Use this location</Trans>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
