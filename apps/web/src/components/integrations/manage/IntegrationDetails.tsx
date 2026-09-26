import type { IntegrationConnection, IntegrationDescriptor } from "@ardurbot/contracts";
import { Button } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { mcpFailureSentence } from "../../../lib/mcp-sign-in";
import { rpc } from "../../../lib/rpc";
import { IntegrationManage } from "../catalog/IntegrationManage";

export function IntegrationDetails({
  descriptor,
  connection,
  onBack,
  onChanged,
  onReconnect,
}: {
  descriptor: IntegrationDescriptor;
  connection: IntegrationConnection;
  onBack: () => void;
  onChanged: () => Promise<void>;
  onReconnect: () => void;
}) {
  const { t } = useLingui();
  const [testing, setTesting] = useState(false);
  const [failed, setFailed] = useState(false);
  const test = async () => {
    setTesting(true);
    setFailed(false);
    try {
      await rpc.integrations.discover({ connectionId: connection.id });
      await onChanged();
    } catch {
      setFailed(true);
    } finally {
      setTesting(false);
    }
  };
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={testing} onClick={() => void test()}>{t`Test`}</Button>
        <Button variant="outline" disabled={testing} onClick={onReconnect}>{t`Reconnect`}</Button>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        {connection.manifest?.workspace ? (
          <>
            <dt>{t`Workspace`}</dt>
            <dd>{connection.manifest.workspace}</dd>
          </>
        ) : null}
        <dt>{t`Tools`}</dt>
        <dd>{connection.manifest?.tools.length ?? 0}</dd>
        <dt>{t`Last checked`}</dt>
        <dd>
          {connection.lastCheckedAt
            ? new Date(connection.lastCheckedAt).toLocaleString()
            : t`Not checked`}
        </dd>
        <dt>{t`Last successful call`}</dt>
        <dd>
          {connection.lastSuccessAt
            ? new Date(connection.lastSuccessAt).toLocaleString()
            : t`Not checked`}
        </dd>
        <dt>{t`Last used`}</dt>
        <dd>
          {connection.lastUsedAt ? new Date(connection.lastUsedAt).toLocaleString() : t`Not used`}
        </dd>
        {connection.manifest?.scopes?.length ? (
          <>
            <dt>{t`Scopes`}</dt>
            <dd>{connection.manifest.scopes.join(", ")}</dd>
          </>
        ) : null}
      </dl>
      {connection.lastError || failed ? (
        <p role="alert" className="text-sm text-destructive">
          {mcpFailureSentence(connection.lastError) ?? t`Could not test this integration.`}
        </p>
      ) : null}
      {connection.recentErrors?.length ? (
        <details>
          <summary className="cursor-pointer text-sm">{t`Recent errors`}</summary>
          <ul className="text-sm">
            {connection.recentErrors.map((entry) => (
              <li key={entry.at}>
                {new Date(entry.at).toLocaleString()}: {entry.message}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <IntegrationManage
        descriptor={descriptor}
        connection={connection}
        onBack={onBack}
        onChanged={onChanged}
      />
    </div>
  );
}
