import type { McpCredentialFlags, McpServer } from "@ardurbot/contracts";
import { mcpEntryIsSecret } from "@ardurbot/contracts";
import { Switch } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";

export function changedMcpCredentialFlags(
  server: McpServer,
  kind: keyof McpCredentialFlags,
  key: string,
  secret: boolean,
): McpCredentialFlags {
  const flags: McpCredentialFlags = {
    env: Object.fromEntries(
      (server.envKeys ?? []).map((name) => [
        name,
        mcpEntryIsSecret(server.credentialFlags, "env", name),
      ]),
    ),
    headers: Object.fromEntries(
      (server.headerKeys ?? []).map((name) => [
        name,
        mcpEntryIsSecret(server.credentialFlags, "headers", name),
      ]),
    ),
  };
  flags[kind][key] = secret;
  return flags;
}

export function McpCredentialFields({
  server,
  disabled,
  onChange,
}: {
  server: McpServer;
  disabled: boolean;
  onChange: (kind: keyof McpCredentialFlags, key: string, secret: boolean) => void;
}) {
  const { t } = useLingui();
  const envKeys = server.envKeys ?? [];
  const headerKeys = server.headerKeys ?? [];
  if (!envKeys.length && !headerKeys.length) return null;

  return (
    <details className="mt-2 text-xs">
      <summary className="cursor-pointer">
        <Trans>Credential fields</Trans>
      </summary>
      {(["env", "headers"] as const).flatMap((kind) =>
        (kind === "env" ? envKeys : headerKeys).map((key) => (
          <div key={`${kind}:${key}`} className="flex items-center justify-between gap-3 py-1">
            <span className="truncate">{key}</span>
            <span className="flex items-center gap-2">
              <Trans>Secret</Trans>
              <Switch
                aria-label={t`Secret for ${key}`}
                checked={mcpEntryIsSecret(server.credentialFlags, kind, key)}
                disabled={disabled || !server.hasSecret}
                onCheckedChange={(checked) => onChange(kind, key, checked)}
              />
            </span>
          </div>
        )),
      )}
    </details>
  );
}
