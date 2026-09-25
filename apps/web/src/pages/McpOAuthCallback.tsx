import { Button } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { MCP_OAUTH_CHANNEL } from "../lib/mcp-oauth-channel";
import { rpc } from "../lib/rpc";

// The window.open name set by the OAuth popup flow. Providers whose login
// pages send COOP sever window.opener mid-flow, but the window name survives,
// so it is the reliable "we are the popup" marker.
const POPUP_NAME = MCP_OAUTH_CHANNEL;

export function McpOAuthCallbackPage() {
  const { t } = useLingui();
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const handledState = useRef<string | null>(null);
  useEffect(() => {
    const code = params.get("code");
    const state = params.get("state");
    if (!code || !state) {
      setError(t`Authorization was cancelled. Try connecting again.`);
      return;
    }
    if (handledState.current === state) return;
    handledState.current = state;
    void rpc.mcp.oauth
      .complete({ sessionId: state, code, state })
      .then((completed) => {
        if (completed.result === "replaced") {
          const channel = new BroadcastChannel(POPUP_NAME);
          channel.postMessage({
            type: "mcp-oauth-complete",
            sessionId: state,
            result: "replaced",
          });
          channel.close();
          setError(
            t`This sign-in window was replaced by a newer one. Finish signing in there, or start again.`,
          );
          return;
        }
        const channel = new BroadcastChannel(POPUP_NAME);
        channel.postMessage({ type: "mcp-oauth-complete", sessionId: state });
        channel.close();
        if (window.name === POPUP_NAME) {
          setDone(true);
          window.close();
          return;
        }
        setDone(true);
        window.close();
      })
      .catch(() => setError(t`Could not complete authorization. Try connecting again.`));
  }, [params, t]);
  const showReturn = Boolean(error) && window.name !== POPUP_NAME;
  return (
    <div className="grid min-h-screen place-items-center bg-background p-6 text-center">
      <div>
        <div className="text-lg text-foreground">
          {error ? (
            <Trans>OAuth connection failed</Trans>
          ) : done ? (
            <Trans>Connected</Trans>
          ) : (
            <Trans>Finishing MCP connection…</Trans>
          )}
        </div>
        {error ? <p className="mt-2 max-w-md text-sm text-muted-foreground">{error}</p> : null}
        {showReturn ? (
          <Button type="button" className="mt-5" onClick={() => window.close()}>
            <Trans>Return to Ardur Bot</Trans>
          </Button>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            {error || done ? (
              <Trans>You can close this window.</Trans>
            ) : (
              <Trans>You can close this tab if it does not redirect automatically.</Trans>
            )}
          </p>
        )}
      </div>
    </div>
  );
}
