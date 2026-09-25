import { describe, expect, it, vi } from "vitest";
import { integrationOAuthReturn } from "./integration-oauth-return.js";

const state = "10000000-0000-4000-8000-000000000000";
function fixture() {
  const owner = { userId: "owner", spaceId: "space", serverId: "connection" };
  const oauth = { completeRedirect: vi.fn(async () => owner) };
  const integrations = {
    capture: vi.fn(),
    owned: vi.fn(async () => ({
      id: "connection",
      name: "Notion",
      catalogId: "notion",
      connectionState: "connected",
    })),
  };
  const app = integrationOAuthReturn(oauth as never, integrations as never);
  return { app, oauth, integrations, owner };
}
describe("API OAuth return page", () => {
  it("does not claim a custom MCP connection succeeded without a successful health check", async () => {
    const f = fixture();
    f.integrations.owned.mockResolvedValue({
      id: "connection",
      name: "Custom server",
      catalogId: null,
      connectionState: "discovery-failed",
    } as never);
    const html = await (await f.app.request(`/?state=${state}&code=fake-code`)).text();
    expect(html).toContain("Could not complete sign-in.");
    expect(html).not.toContain("Connected to Custom server");
    expect(html).not.toContain("window.close()");
  });
  it("completes server-side without a browser session and renders a minimal close-and-return page", async () => {
    const f = fixture();
    const response = await f.app.request(`/?state=${state}&code=fake-code`);
    const html = await response.text();
    expect(f.oauth.completeRedirect).toHaveBeenCalledWith({ state, code: "fake-code" });
    expect(f.integrations.capture).toHaveBeenCalledWith(f.owner, "connection");
    expect(response.status).toBe(200);
    expect(html).toContain("Connected to Notion. You can close this tab and return to Ardur Bot.");
    expect(html).toContain("window.close()");
    expect(html).toContain('BroadcastChannel("ardurbot-mcp-oauth")');
    expect(html).toContain("ardurbot://integrations/connection");
    expect(html).not.toMatch(/\/app|react|assets\/|location\.(?:href|assign|replace)|fake-code/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });
  it("escapes provider names and returns no raw provider failure or authorization code", async () => {
    const f = fixture();
    f.integrations.owned.mockResolvedValue({
      id: "connection",
      name: "<script>example</script>",
      catalogId: "notion",
      connectionState: "connected",
    });
    expect(await (await f.app.request(`/?state=${state}&code=fake-code`)).text()).toContain(
      "&lt;script&gt;",
    );
    f.oauth.completeRedirect.mockRejectedValue(new Error("fake-sensitive-response"));
    const html = await (await f.app.request(`/?state=${state}&code=fake-code`)).text();
    expect(html).toContain("Could not complete sign-in.");
    expect(html).not.toMatch(/fake-sensitive|fake-code|\/app/);
  });
  it.each(["?state=invalid&code=fake", `?state=${state}`])(
    "rejects invalid callbacks %s",
    async (query) => {
      const f = fixture();
      expect(await (await f.app.request(`/${query}`)).text()).toContain(
        "Could not complete sign-in.",
      );
      expect(f.oauth.completeRedirect).not.toHaveBeenCalled();
    },
  );
});

it("consumes a denied state server-side without exposing the provider response", async () => {
  const f = fixture();
  f.oauth.completeRedirect.mockRejectedValue(new Error("denied"));
  const html = await (
    await f.app.request(`/?state=${state}&error=access_denied&error_description=fake-private`)
  ).text();
  expect(f.oauth.completeRedirect).toHaveBeenCalledWith({ state, error: "access_denied" });
  expect(html).toContain("Could not complete sign-in.");
  expect(html).not.toContain("fake-private");
});
