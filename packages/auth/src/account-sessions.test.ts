import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { bearer } from "better-auth/plugins";
import { describe, expect, it } from "vitest";
import { accountSessions } from "./account-sessions.js";
import type { Auth } from "./index.js";

async function fixture() {
  const data = { user: [], session: [], account: [], verification: [] };
  const auth = betterAuth({
    secret: "offline-account-session-test-material-32-characters",
    baseURL: "http://auth.example.test",
    database: memoryAdapter(data),
    emailAndPassword: { enabled: true },
    plugins: [bearer()],
  });
  const identity = {
    email: "operator@example.test",
    password: "fixture-password-123",
    name: "Test operator",
  };
  const first = await auth.api.signUpEmail({
    body: identity,
    headers: new Headers({ "user-agent": "Electron/40.0" }),
  });
  const second = await auth.api.signInEmail({
    body: identity,
    headers: new Headers({ "user-agent": "Mozilla/5.0 (Linux) Firefox/128.0" }),
  });
  const headers = new Headers({ authorization: `Bearer ${first.token}` });
  return {
    auth,
    api: accountSessions(auth as unknown as Auth),
    headers,
    userId: first.user.id,
    otherToken: second.token,
  };
}

describe("account sessions with the installed Better Auth", () => {
  it("lists safe metadata and revokes all other sessions while preserving the current one", async () => {
    const f = await fixture();
    const rows = await f.api.list(f.userId, f.headers);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.current)).toHaveLength(1);
    expect(rows.find((row) => row.current)?.device).toBe("Desktop app");
    expect(JSON.stringify(rows)).not.toMatch(/token|ipAddress|userAgent/);
    await f.api.revokeOthers(f.userId, f.headers);
    expect(await f.api.list(f.userId, f.headers)).toEqual(rows.filter((row) => row.current));
    expect(
      await f.auth.api.getSession({
        headers: new Headers({ authorization: `Bearer ${f.otherToken}` }),
      }),
    ).toBeNull();
  });
  it("revokes by opaque id and refuses another user's session scope", async () => {
    const f = await fixture();
    await expect(f.api.list("different-user", f.headers)).rejects.toThrow("Sign in again");
    const target = (await f.api.list(f.userId, f.headers)).find((row) => !row.current)!;
    await f.api.revoke(f.userId, f.headers, target.id);
    expect(await f.api.list(f.userId, f.headers)).toHaveLength(1);
    const current = (await f.api.list(f.userId, f.headers))[0]!;
    await f.api.revoke(f.userId, f.headers, current.id);
    expect(await f.auth.api.getSession({ headers: f.headers })).toBeNull();
  });
});
