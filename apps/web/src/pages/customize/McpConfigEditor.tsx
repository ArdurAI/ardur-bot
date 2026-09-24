import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Textarea,
} from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { rpc, selectedSpaceId } from "../../lib/rpc";
import { ensureCustomizationHost } from "./native";

type Preview = Awaited<ReturnType<typeof rpc.developer.preview>>;
export function McpConfigEditor({ onClose, onApplied }: { onClose(): void; onApplied(): void }) {
  const { t } = useLingui();
  const [config, setConfig] = useState({ json: "", revision: "" });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void rpc.developer
      .config()
      .then(setConfig, () => setError(t`Could not load the server configuration.`));
  }, [t]);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (!preview) setPreview(await rpc.developer.preview(config));
      else {
        const native = await ensureCustomizationHost();
        await native.applyConfig(selectedSpaceId(), preview.id);
        onApplied();
        onClose();
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : t`Could not complete this action.`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{preview ? t`Review changes` : t`Edit config`}</DialogTitle>
        </DialogHeader>
        {preview ? (
          <div className="max-h-96 space-y-4 overflow-auto">
            {preview.changes.length ? (
              preview.changes.map((change) => (
                <div key={change.name} className="space-y-2">
                  <p className="text-sm font-medium">
                    {change.name} ·{" "}
                    {change.action === "add"
                      ? t`Add`
                      : change.action === "remove"
                        ? t`Remove`
                        : t`Change`}
                  </p>
                  {change.action === "change" && change.before === change.after ? (
                    <p className="text-xs text-muted-foreground">{t`Credentials changed`}</p>
                  ) : null}
                  <div className="grid gap-2 sm:grid-cols-2">
                    {change.before ? (
                      <section aria-label={t`Before`}>
                        <pre className="overflow-auto rounded border border-border bg-muted p-2 text-xs">
                          {change.before}
                        </pre>
                      </section>
                    ) : null}
                    {change.after ? (
                      <section aria-label={t`After`}>
                        <pre className="overflow-auto rounded border border-border bg-muted p-2 text-xs">
                          {change.after}
                        </pre>
                      </section>
                    ) : null}
                  </div>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">{t`No changes.`}</p>
            )}
          </div>
        ) : (
          <Textarea
            aria-label={t`Server configuration JSON`}
            className="min-h-72 font-mono text-xs"
            value={config.json}
            onChange={(event) => setConfig({ ...config, json: event.target.value })}
            spellCheck={false}
          />
        )}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => (preview ? setPreview(null) : onClose())}
          >
            {preview ? t`Back` : t`Cancel`}
          </Button>
          <Button
            disabled={busy || !config.revision || (preview !== null && !preview.changes.length)}
            onClick={() => void save()}
          >
            {preview ? t`Apply` : t`Review changes`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
