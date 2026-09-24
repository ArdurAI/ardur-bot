import { memoryProviderHost } from "@ardurbot/contracts";
import { Button, Field, FieldLabel, Input } from "@ardurbot/ui-web";
import { Trans } from "@lingui/react/macro";
import { useId, useState } from "react";
import type { MemoryProviderSettingsFormProps } from "./registry";

function ExternalMemorySettingsForm({
  provider,
  busy,
  onConnect,
}: MemoryProviderSettingsFormProps & { provider: "mem0" | "mem0-oss" | "graphiti" }) {
  const urlId = useId();
  const keyId = useId();
  const [baseUrl, setBaseUrl] = useState(provider === "mem0" ? "https://api.mem0.ai" : "");
  const [credential, setCredential] = useState("");
  const host = memoryProviderHost({ baseUrl });
  return (
    <div className="space-y-3">
      {provider !== "mem0" ? (
        <Field>
          <FieldLabel htmlFor={urlId}>
            <Trans>Base URL</Trans>
          </FieldLabel>
          <Input
            id={urlId}
            type="url"
            value={baseUrl}
            disabled={busy}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </Field>
      ) : null}
      <Field>
        <FieldLabel htmlFor={keyId}>
          {provider === "graphiti" ? (
            <Trans>Bearer token (optional)</Trans>
          ) : provider === "mem0-oss" ? (
            <Trans>API key (optional)</Trans>
          ) : (
            <Trans>API key</Trans>
          )}
        </FieldLabel>
        <Input
          id={keyId}
          type="password"
          autoComplete="new-password"
          value={credential}
          disabled={busy}
          onChange={(event) => setCredential(event.target.value)}
        />
      </Field>
      {host ? (
        <p className="text-sm text-muted-foreground">
          <Trans>Sends memory text to {host}</Trans>
        </p>
      ) : null}
      <Button
        variant="secondary"
        disabled={busy || !host || (provider === "mem0" && !credential.trim())}
        onClick={() =>
          void onConnect({
            settings: { baseUrl: baseUrl.trim() },
            credentials: credential.trim()
              ? { [provider === "graphiti" ? "token" : "apiKey"]: credential.trim() }
              : {},
          }).then((ok) => {
            if (ok) setCredential("");
          })
        }
      >
        {busy ? <Trans>Testing…</Trans> : <Trans>Test connection</Trans>}
      </Button>
    </div>
  );
}
export function Mem0SettingsForm(props: MemoryProviderSettingsFormProps) {
  return <ExternalMemorySettingsForm {...props} provider="mem0" />;
}
export function Mem0OssSettingsForm(props: MemoryProviderSettingsFormProps) {
  return <ExternalMemorySettingsForm {...props} provider="mem0-oss" />;
}
export function GraphitiSettingsForm(props: MemoryProviderSettingsFormProps) {
  return <ExternalMemorySettingsForm {...props} provider="graphiti" />;
}
