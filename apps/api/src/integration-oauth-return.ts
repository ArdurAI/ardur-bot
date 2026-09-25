import { randomBytes } from "node:crypto";
import type { McpOAuthBroker } from "@ardurbot/adapters";
import { Hono } from "hono";
import type { IntegrationConnections } from "./integration-connections.js";

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );

/** The state capability and encrypted PKCE verifier authorize this one exchange, not a cookie. */
export function integrationOAuthReturn(
  oauth: McpOAuthBroker,
  integrations: IntegrationConnections,
) {
  const app = new Hono();
  app.get("/", async (c) => {
    const state = c.req.query("state") ?? "";
    const code = c.req.query("code");
    let name: string | undefined;
    let id: string | undefined;
    let message = "Could not complete sign-in. Return to Ardur Bot and connect again.";
    try {
      const denied = c.req.query("error");
      if (!/^[a-f0-9-]{36}$/i.test(state) || (!code && !denied) || (code?.length ?? 0) > 8192)
        throw new Error("Invalid callback");
      const result = await oauth.completeRedirect({
        state,
        ...(denied
          ? { error: denied === "access_denied" ? "access_denied" : "authorization_failed" }
          : { code }),
      });
      await integrations.capture(result, result.serverId, state);
      const server = await integrations.owned(result, result.serverId);
      id = server.id;
      if (server.connectionState === "connected") {
        name = server.name;
        message = `Connected to ${name}. You can close this tab and return to Ardur Bot.`;
      }
    } catch {
      // Codes, tokens and provider response bodies never enter a page or log.
    }
    const nonce = randomBytes(18).toString("base64");
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Content-Type-Options", "nosniff");
    c.header(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
    );
    const destination = id
      ? `ardurbot://integrations/${encodeURIComponent(id)}`
      : "ardurbot://integrations";
    return c.html(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ardur Bot</title><body><main><p>${escapeHtml(message)}</p><a href="${escapeHtml(destination)}">Open Ardur Bot</a></main><script nonce="${nonce}">history.replaceState(null,"",location.pathname);${name ? `try { const channel = new BroadcastChannel("ardurbot-mcp-oauth"); channel.postMessage({type:"mcp-oauth-complete",sessionId:${JSON.stringify(state)}}); channel.close(); } catch {} window.close();` : ""}</script></body></html>`,
    );
  });
  return app;
}
