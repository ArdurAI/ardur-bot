import type { IntegrationSetupState } from "@ardurbot/contracts";
import { Button, Input } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { Check } from "lucide-react";
import { lazy, Suspense, useEffect, useId, useRef, useState } from "react";
import type { McpOauthWait } from "../../lib/mcp-connect";
import { rpc } from "../../lib/rpc";

const DirectMcpSearch = lazy(() =>
  import("./DirectMcpSearch").then((module) => ({ default: module.DirectMcpSearch })),
);

type Choice = "direct" | "composio" | "pipedream" | "executor";

export function IntegrationSetup({
  onDone,
  serverSetup = false,
  managedOnly = false,
  initialState,
  botId,
  onServerConnected,
}: {
  onDone?: () => void;
  serverSetup?: boolean;
  /** Local host settings can configure providers, but cannot access account MCP servers. */
  managedOnly?: boolean;
  initialState?: IntegrationSetupState | null;
  botId?: string;
  onServerConnected?: (id: string) => void;
}) {
  const { t } = useLingui();
  const fieldId = useId();
  const [state, setState] = useState<IntegrationSetupState | null>(initialState ?? null);
  const [selectedChoice, setChoice] = useState<Choice>(managedOnly ? "composio" : "direct");
  const choice = serverSetup ? selectedChoice : "direct";
  const [apiKey, setApiKey] = useState("");
  const [clientId, setClientId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [oauthWait, setOauthWait] = useState<McpOauthWait | null>(null);
  const userCancelled = useRef(false);
  const choices: { id: Choice; label: string }[] = [
    { id: "direct", label: t`Direct MCP` },
    { id: "composio", label: "Composio" },
    { id: "pipedream", label: "Pipedream" },
    { id: "executor", label: "Executor" },
  ];
  const managed = choice === "composio" || choice === "pipedream";
  const hasCredentials = Boolean(apiKey.trim());
  const credentialsReady =
    hasCredentials && (choice !== "pipedream" || Boolean(clientId.trim() && projectId.trim()));
  const configured = state?.providers.find((provider) => provider.id === choice)?.configured;
  useEffect(() => {
    if (!serverSetup || initialState) return;
    void rpc.integrationSetup
      .get()
      .then(setState)
      .catch(() => setError(t`Could not load integrations`));
  }, [serverSetup, initialState]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not connect`);
    } finally {
      setBusy(false);
    }
  }

  async function saveProvider() {
    await run(async () => {
      await rpc.integrationSetup.save(
        choice === "composio"
          ? { provider: "composio", apiKey }
          : {
              provider: "pipedream",
              clientId,
              clientSecret: apiKey,
              projectId,
              environment: "production",
            },
      );
      setApiKey("");
      setState(await rpc.integrationSetup.get());
      onDone?.();
    });
  }

  if (serverSetup && !state?.canConfigure) return error ? <p role="alert">{error}</p> : null;

  return (
    <div className="space-y-6">
      <h1 className="text-[32px] font-medium text-foreground">
        {serverSetup ? t`Server integrations` : t`Add MCP server`}
      </h1>
      {serverSetup ? (
        <fieldset
          aria-label={t`Integration options`}
          className="overflow-hidden rounded-xl border border-border"
        >
          {choices
            .filter(({ id }) => !managedOnly || id === "composio" || id === "pipedream")
            .map(({ id, label }) => (
              <button
                key={id}
                type="button"
                aria-pressed={choice === id}
                disabled={busy}
                onClick={() => {
                  setChoice(id);
                  setApiKey("");
                  setError(null);
                }}
                className={`flex min-h-11 w-full items-center justify-between border-b border-border px-3.5 py-2.5 text-left last:border-0 ${choice === id ? "bg-muted" : "hover:bg-accent"}`}
              >
                <span>{label}</span>
                {choice === id ? <Check className="size-4" aria-hidden /> : null}
              </button>
            ))}
        </fieldset>
      ) : null}
      {choice === "composio" || choice === "pipedream" ? (
        <>
          {configured ? (
            <p className="text-sm text-success">
              <Trans>Connected</Trans>
            </p>
          ) : null}
          {state?.canConfigure ? (
            <>
              {choice === "pipedream" ? (
                <>
                  <label htmlFor={`${fieldId}-client-id`} className="block text-sm">
                    <Trans>Client ID</Trans>
                    <Input
                      id={`${fieldId}-client-id`}
                      className="mt-2"
                      value={clientId}
                      onChange={(event) => setClientId(event.target.value)}
                      autoComplete="off"
                    />
                  </label>
                  <label htmlFor={`${fieldId}-project-id`} className="block text-sm">
                    <Trans>Project ID</Trans>
                    <Input
                      id={`${fieldId}-project-id`}
                      className="mt-2"
                      value={projectId}
                      onChange={(event) => setProjectId(event.target.value)}
                      autoComplete="off"
                    />
                  </label>
                </>
              ) : null}
              <label htmlFor={`${fieldId}-key`} className="block text-sm">
                {choice === "composio" ? t`API key` : t`Client secret`}
                <Input
                  id={`${fieldId}-key`}
                  className="mt-2"
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  autoComplete="new-password"
                />
              </label>
              <a
                className="text-sm text-muted-foreground underline"
                href={
                  choice === "composio"
                    ? "https://dashboard.composio.dev"
                    : "https://pipedream.com/docs/connect/mcp/developers"
                }
                target="_blank"
                rel="noreferrer"
              >
                <Trans>Get credentials</Trans>
              </a>
              {!onDone ? (
                <Button
                  className="ml-3"
                  disabled={busy || !credentialsReady}
                  onClick={() => void saveProvider()}
                >
                  {busy ? t`Connecting…` : t`Connect`}
                </Button>
              ) : null}
            </>
          ) : state && !configured ? (
            <p className="text-sm text-muted-foreground">
              <Trans>Ask the server owner to configure this provider.</Trans>
            </p>
          ) : null}
        </>
      ) : null}
      {choice === "direct" ? (
        <Suspense fallback={null}>
          <DirectMcpSearch botId={botId} onConnected={(id) => onServerConnected?.(id)} />
        </Suspense>
      ) : null}
      {choice === "executor" ? (
        <div className="space-y-3">
          <label htmlFor={`${fieldId}-endpoint`} className="block text-sm">
            <Trans>Server URL</Trans>
            <Input
              id={`${fieldId}-endpoint`}
              className="mt-2"
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
              placeholder="http://localhost:8000/mcp"
            />
          </label>
          <label htmlFor={`${fieldId}-token`} className="block text-sm">
            <Trans>Access token</Trans>
            <Input
              id={`${fieldId}-token`}
              className="mt-2"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              type="password"
              autoComplete="new-password"
            />
          </label>
          <Button
            disabled={(busy && !oauthWait) || !endpoint.trim()}
            onClick={() => {
              userCancelled.current = false;
              void run(async () => {
                const { connectRemoteMcp } = await import("./connect-remote-mcp");
                const outcome = await connectRemoteMcp({
                  name: "Executor",
                  endpoint,
                  credential: apiKey.trim() ? { value: apiKey } : undefined,
                  botId,
                  onWaiting: (waiting) => {
                    setBusy(false);
                    setOauthWait(waiting);
                  },
                });
                setOauthWait(null);
                if (typeof outcome === "object") {
                  onServerConnected?.(outcome.serverId);
                  return;
                }
                setError(
                  outcome === "credential-rejected"
                    ? t`That token was not accepted. Check it and try again.`
                    : outcome === "needs-credential"
                      ? t`Enter a credential for this server and try again.`
                      : outcome === "cancelled"
                        ? userCancelled.current
                          ? t`Sign-in was cancelled.`
                          : t`Sign-in was declined. Reconnect to try again.`
                        : outcome === "needs-sign-in"
                          ? t`Sign-in did not finish. Try again.`
                          : outcome === "replaced"
                            ? t`This sign-in window was replaced by a newer one. Finish signing in there, or start again.`
                            : t`Could not finish sign-in. Try again.`,
                );
              });
            }}
          >
            <Trans>Connect</Trans>
          </Button>
          {oauthWait ? (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">{t`Waiting for sign-in in the other window.`}</p>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  userCancelled.current = true;
                  void oauthWait.cancel();
                }}
              >{t`Cancel sign-in`}</Button>
            </div>
          ) : null}
          <details className="text-sm text-muted-foreground">
            <summary className="cursor-pointer">
              <Trans>Setup help</Trans>
            </summary>
            <a
              href="https://executor.sh/#get-started"
              target="_blank"
              rel="noreferrer"
              className="mt-2 block underline"
            >
              <Trans>Download Executor</Trans>
            </a>
          </details>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {onDone ? (
        <div className="flex gap-3">
          <Button
            disabled={
              busy ||
              (managed &&
                state?.canConfigure &&
                !credentialsReady &&
                (!configured || hasCredentials))
            }
            onClick={() => {
              if (managed && hasCredentials) void saveProvider();
              else onDone();
            }}
          >
            {busy ? t`Connecting…` : t`Continue`}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={onDone}>
            <Trans>Skip</Trans>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
