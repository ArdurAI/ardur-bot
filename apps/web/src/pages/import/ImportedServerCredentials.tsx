import type { McpServer } from "@ardurbot/contracts";
import { Button, Input } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { rpc } from "../../lib/rpc";

export function ImportedServerCredentials({
  server,
  onSaved,
}: {
  server: McpServer;
  onSaved: () => Promise<void>;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  if (!server.imported || (!server.envKeys.length && !server.headerKeys.length)) return null;
  if (!open)
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        {server.hasSecret ? t`Update credentials` : t`Set up credentials`}
      </Button>
    );
  return (
    <form
      className="mt-3 space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(false);
        void rpc.localImport
          .credentials({
            serverId: server.id,
            env: Object.fromEntries(server.envKeys.map((key) => [key, values[`env:${key}`] ?? ""])),
            headers: Object.fromEntries(
              server.headerKeys.map((key) => [key, values[`header:${key}`] ?? ""]),
            ),
          })
          .then(async () => {
            setValues({});
            setOpen(false);
            await onSaved();
          })
          .catch(() => setError(true))
          .finally(() => setBusy(false));
      }}
    >
      {[
        ...server.envKeys.map((key) => ({ id: `env:${key}`, key })),
        ...server.headerKeys.map((key) => ({ id: `header:${key}`, key })),
      ].map(({ id, key }) => (
        <div key={id} className="space-y-1">
          <label htmlFor={`${server.id}-${id}`} className="text-sm">
            {key}
          </label>
          <Input
            id={`${server.id}-${id}`}
            type="password"
            autoComplete="off"
            value={values[id] ?? ""}
            onChange={(event) => setValues((current) => ({ ...current, [id]: event.target.value }))}
            required
            disabled={busy}
          />
        </div>
      ))}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          <Trans>Could not save credentials. Check each field and retry.</Trans>
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          <Trans>Save credentials</Trans>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => {
            setValues({});
            setOpen(false);
          }}
        >
          <Trans>Cancel</Trans>
        </Button>
      </div>
    </form>
  );
}
