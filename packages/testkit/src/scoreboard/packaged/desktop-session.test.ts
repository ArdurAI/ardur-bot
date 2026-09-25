import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ElectronAuthCookie } from "./desktop-session.js";
import {
  electronAuthCookie,
  persistentAuthCookies,
  primeDesktopWindowSession,
  SYNTHETIC_AUTH_LIFETIME_SECONDS,
  selectPrimingCookieStore,
} from "./desktop-session.js";

describe("desktop priming session", () => {
  it("gives synthetic auth cookies a bounded persistent lifetime", () => {
    const nowMs = 1_700_000_000_000;
    const cookies = persistentAuthCookies(
      "better-auth.session_token=synthetic-token; better-auth.session_data=synthetic-data",
      "http://127.0.0.1:4010",
      nowMs,
    );
    expect(cookies.map((cookie) => cookie.name)).toEqual([
      "better-auth.session_token",
      "better-auth.session_data",
    ]);
    expect(cookies.map((cookie) => cookie.value)).toEqual(["synthetic-token", "synthetic-data"]);
    for (const cookie of cookies) {
      expect(cookie.url).toBe("http://127.0.0.1:4010");
      expect(cookie.path).toBe("/");
      expect(cookie.httpOnly).toBe(true);
      expect(cookie.sameSite).toBe("Lax");
      const lifetime = cookie.expires! - Math.floor(nowMs / 1000);
      expect(lifetime).toBe(SYNTHETIC_AUTH_LIFETIME_SECONDS);
      expect(lifetime).toBeGreaterThan(0);
      expect(lifetime).toBeLessThanOrEqual(60 * 60);
      const stored = electronAuthCookie(cookie);
      expect(stored.expirationDate).toBe(cookie.expires);
      expect(stored.sameSite).toBe("lax");
      expect(stored).not.toHaveProperty("expires");
    }
  });

  it("seeds the priming window session instead of the default browser context", async () => {
    const seen: string[] = [];
    const browserContext = {
      kind: "browser-context" as const,
      set: async () => {
        seen.push("browser-context");
      },
    };
    const webContentsSession = {
      kind: "web-contents-session" as const,
      set: async () => {
        seen.push("web-contents-session");
      },
    };
    const selected = selectPrimingCookieStore({ browserContext, webContentsSession });
    expect(selected).toBe(webContentsSession);
    await selected.set([]);
    expect(seen).toEqual(["web-contents-session"]);
    expect(() => selectPrimingCookieStore({ browserContext, webContentsSession: null })).toThrow(
      /window session/,
    );
  });

  it("flushes Electron cookie records on the priming window the stack evaluates", async () => {
    const cookies = persistentAuthCookies(
      "better-auth.session_token=synthetic-token; better-auth.session_data=synthetic-data",
      "http://127.0.0.1:4010",
      1_700_000_000_000,
    );
    const events: string[] = [];
    const received: ElectronAuthCookie[] = [];
    await primeDesktopWindowSession(
      {
        evaluate: async (pageFunction, details) => {
          await pageFunction(
            {
              isDestroyed: () => false,
              webContents: {
                isDestroyed: () => false,
                session: {
                  cookies: {
                    set: async (item) => {
                      received.push(item);
                      events.push(`set:${item.name}`);
                    },
                    flushStore: async () => {
                      events.push("flush");
                    },
                  },
                },
              },
            },
            details,
          );
        },
      },
      cookies,
    );
    expect(events).toEqual([
      "set:better-auth.session_token",
      "set:better-auth.session_data",
      "flush",
    ]);
    expect(received).toHaveLength(2);
    for (const [index, stored] of received.entries()) {
      expect(stored.expirationDate).toBe(cookies[index]!.expires);
      expect(stored.sameSite).toBe("lax");
      expect(stored.httpOnly).toBe(true);
      expect(stored.path).toBe("/");
      expect(stored.url).toBe("http://127.0.0.1:4010");
      expect(stored).not.toHaveProperty("expires");
    }
    const stack = readFileSync(new URL("./local-stack.ts", import.meta.url), "utf8");
    expect(stack).toContain("primeDesktopWindowSession(primingWindow, records)");
  });
});
