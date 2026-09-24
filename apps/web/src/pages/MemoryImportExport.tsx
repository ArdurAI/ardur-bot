import type { DocumentScope, MemoryBundle, MemoryImportPreview } from "@ardurbot/contracts";
import { MemoryBundleSchema } from "@ardurbot/contracts";
import { Button, Input, NativeSelect, NativeSelectOption } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useId, useState } from "react";
import { downloadArtifactBytes } from "../lib/artifact-open";
import { rpc } from "../lib/rpc";

function key(scope: DocumentScope) {
  return JSON.stringify(
    scope.kind === "space-shared"
      ? [scope.spaceId, scope.kind]
      : scope.kind === "user"
        ? [scope.spaceId, scope.kind, scope.userId]
        : [scope.spaceId, scope.kind, scope.userId, scope.botId],
  );
}
export function MemoryImportExport({ onImported }: { onImported: () => void }) {
  const { t } = useLingui();
  const importId = useId();
  const [bundle, setBundle] = useState<MemoryBundle | null>(null);
  const [remapping, setRemapping] = useState<Record<string, DocumentScope>>({});
  const [preview, setPreview] = useState<MemoryImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [destinations, setDestinations] = useState<Array<{ label: string; scope: DocumentScope }>>(
    [],
  );
  async function load(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    setPreview(null);
    setBundle(null);
    try {
      if (file.size > 20_000_000) throw new Error("size");
      const data = MemoryBundleSchema.parse(JSON.parse(await file.text()));
      const [me, bots] = await Promise.all([rpc.me(), rpc.bots.list()]);
      setDestinations([
        { label: t`My documents`, scope: { kind: "user", spaceId: me.spaceId, userId: me.userId } },
        { label: t`Space shared`, scope: { kind: "space-shared", spaceId: me.spaceId } },
        ...bots.map((bot) => ({
          label: bot.name,
          scope: { kind: "bot" as const, spaceId: me.spaceId, userId: me.userId, botId: bot.id },
        })),
      ]);
      setBundle(data);
      setRemapping({});
    } catch {
      setError(t`Could not read this memory bundle. Choose a valid export.`);
    } finally {
      setBusy(false);
    }
  }
  async function submit(write: boolean) {
    if (!bundle) return;
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.memory.import({
        bundle,
        remapping,
        ...(write && preview ? { expectedHash: preview.hash } : {}),
      });
      setPreview(result);
      if (write) {
        setBundle(null);
        setPreview(null);
        onImported();
      }
    } catch {
      setError(
        t`Could not import these documents. Check scopes and conflicts, then preview again.`,
      );
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }
  async function download() {
    setBusy(true);
    setError(null);
    try {
      const data = await rpc.memory.export();
      downloadArtifactBytes(
        "memory-v1.json",
        "application/json",
        new TextEncoder().encode(JSON.stringify(data, null, 2)),
      );
    } catch {
      setError(t`Could not export memory. Retry.`);
    } finally {
      setBusy(false);
    }
  }
  const scopes = bundle
    ? [
        ...new Map(
          bundle.documents.map((doc) => {
            const scope = doc.revisions[0]!.scopeKey;
            return [key(scope), scope];
          }),
        ),
      ]
    : [];
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Button variant="outline" disabled={busy} onClick={() => void download()}>
          <Trans>Export with history</Trans>
        </Button>
        <label className="text-sm" htmlFor={importId}>
          <Trans>Import</Trans>
          <Input
            id={importId}
            aria-label={t`Import memory bundle`}
            type="file"
            accept="application/json,.json"
            disabled={busy}
            onChange={(event) => void load(event.target.files?.[0])}
          />
        </label>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {bundle ? (
        <div className="space-y-2 rounded border border-border p-3">
          {scopes.map(([from, scope], index) => (
            <label className="block text-sm" key={from} htmlFor={`${importId}-scope-${index}`}>
              {scope.kind}
              <NativeSelect
                id={`${importId}-scope-${index}`}
                aria-label={t`Destination scope`}
                value={remapping[from] ? JSON.stringify(remapping[from]) : "keep"}
                disabled={busy}
                onChange={(event) => {
                  const value = event.target.value;
                  setRemapping((current) => {
                    const next = { ...current };
                    if (value === "keep") delete next[from];
                    else next[from] = JSON.parse(value) as DocumentScope;
                    return next;
                  });
                  setPreview(null);
                }}
              >
                <NativeSelectOption value="keep">
                  <Trans>Keep scope</Trans>
                </NativeSelectOption>
                {destinations.map((destination) => (
                  <NativeSelectOption
                    key={key(destination.scope)}
                    value={JSON.stringify(destination.scope)}
                  >
                    {destination.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
          ))}
          {preview ? (
            <>
              <p>
                <Trans>
                  {preview.documents} documents, {preview.revisions} revisions
                </Trans>
              </p>
              <p className="break-all font-mono text-xs">{preview.hash}</p>
              {preview.conflicts.map((conflict) => (
                <p className="text-destructive" key={conflict.id}>
                  <Trans>Conflict: {conflict.path}</Trans>
                </p>
              ))}
            </>
          ) : null}
          <div className="flex gap-2">
            <Button disabled={busy} variant="outline" onClick={() => void submit(false)}>
              <Trans>Preview import</Trans>
            </Button>
            {preview ? (
              <Button
                disabled={busy || preview.conflicts.length > 0}
                onClick={() => void submit(true)}
              >
                <Trans>Import</Trans>
              </Button>
            ) : null}
            <Button
              variant="ghost"
              onClick={() => {
                setBundle(null);
                setPreview(null);
              }}
            >
              <Trans>Cancel</Trans>
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
