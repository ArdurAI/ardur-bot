import type { McpServer } from "@ardurbot/contracts";
import { Button, Input, Tabs, TabsList, TabsTrigger } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { mcpSignIn } from "../../lib/mcp-sign-in";
import { rpc } from "../../lib/rpc";

/**
 * Replaces a custom server's stored token or header. Imported servers keep their own
 * credential form (ImportedServerCredentials); managed, stdio and host-cli servers have
 * no static credential of this kind; a healthy server has nothing to fix.
 */
export function McpCredentialFix({
  server,
  open,
  onOpenChange,
  onSaved,
}: {
  server: McpServer;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useLingui();
  const [mode, setMode] = useState<"token" | "header">("token");
  const [token, setToken] = useState("");
  const [headerName, setHeaderName] = useState(server.headerKeys?.[0] ?? "Authorization");
  const [headerValue, setHeaderValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [keepError, setKeepError] = useState<string | null>(null);

  // The Update credential form starts each time it opens (and stops showing a stale
  // failure once it closes) with no leftover error from a previous attempt.
  useEffect(() => {
    setError(false);
  }, [open]);

  if (server.imported || server.managedBy) return null;
  if (server.transport === "stdio" || server.transport === "host-cli") return null;
  if (!server.credentialConflict && !mcpSignIn(server.lastError)?.credential) return null;

  async function keepToken() {
    setBusy(true);
    setError(false);
    setKeepError(null);
    try {
      // Headers use full-replace semantics: an empty set drops the stored header
      // without needing its value, and leaves the token untouched.
      await rpc.mcp.servers.update({ id: server.id, headers: {} });
      onOpenChange(false);
      await onSaved();
    } catch {
      setKeepError(t`Could not save. Try again.`);
    } finally {
      setBusy(false);
    }
  }

  async function keepHeader() {
    setBusy(true);
    setError(false);
    setKeepError(null);
    try {
      // `secret: null` drops the stored token without needing its value, and leaves
      // whichever header is already stored untouched.
      await rpc.mcp.servers.update({ id: server.id, secret: null });
      onOpenChange(false);
      await onSaved();
    } catch {
      setKeepError(t`Could not save. Try again.`);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setError(false);
    setKeepError(null);
    try {
      if (mode === "token") await rpc.mcp.servers.update({ id: server.id, secret: token.trim() });
      else
        await rpc.mcp.servers.update({
          id: server.id,
          headers: { [headerName.trim() || "Authorization"]: headerValue.trim() },
        });
      // A saved credential is checked once, the way the add flow does, so the
      // server's own state says whether it works instead of sending Reconnect
      // straight back to this form.
      await rpc.mcp.servers.tools({ serverId: server.id }).catch(() => undefined);
      setToken("");
      setHeaderValue("");
      onOpenChange(false);
      await onSaved();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 space-y-2">
      {server.credentialConflict ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-destructive" role="alert">
            <Trans>This server has two credentials. Keep one.</Trans>
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void keepToken()}
          >
            <Trans>Keep token</Trans>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void keepHeader()}
          >
            <Trans>Keep header</Trans>
          </Button>
          {keepError ? (
            <p role="alert" className="text-sm text-destructive">
              {keepError}
            </p>
          ) : null}
        </div>
      ) : null}
      {!open ? (
        <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(true)}>
          {t`Update credential`}
        </Button>
      ) : (
        <div className="space-y-3 rounded-xl border border-border p-3">
          <Tabs value={mode} onValueChange={(value) => setMode(value as "token" | "header")}>
            <TabsList>
              <TabsTrigger value="token">{t`Token`}</TabsTrigger>
              <TabsTrigger value="header">{t`Header`}</TabsTrigger>
            </TabsList>
          </Tabs>
          {mode === "token" ? (
            <Input
              type="password"
              autoComplete="off"
              aria-label={t`New access token`}
              value={token}
              onChange={(event) => setToken(event.target.value)}
              disabled={busy}
            />
          ) : (
            <div className="grid grid-cols-[.7fr_1fr] gap-2">
              <Input
                aria-label={t`Header name`}
                value={headerName}
                onChange={(event) => setHeaderName(event.target.value)}
                disabled={busy}
              />
              <Input
                type="password"
                autoComplete="off"
                aria-label={t`Header value`}
                value={headerValue}
                onChange={(event) => setHeaderValue(event.target.value)}
                disabled={busy}
              />
            </div>
          )}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              <Trans>Could not save this credential. Check it and try again.</Trans>
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              disabled={busy || (mode === "token" ? !token.trim() : !headerValue.trim())}
              onClick={() => void save()}
            >
              <Trans>Save</Trans>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              <Trans>Cancel</Trans>
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
