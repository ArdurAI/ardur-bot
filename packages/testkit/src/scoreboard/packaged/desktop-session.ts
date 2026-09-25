/** One trial, not a remembered sign-in. Session cookies do not survive the priming process. */
export const SYNTHETIC_AUTH_LIFETIME_SECONDS = 60 * 60;

export interface PersistentAuthCookie {
  name: string;
  value: string;
  url: string;
  path: "/";
  httpOnly: true;
  sameSite: "Lax";
  /** Unix seconds. Required so the cookie outlives the priming Electron process. */
  expires: number;
}

export interface ElectronAuthCookie {
  url: string;
  name: string;
  value: string;
  path: "/";
  httpOnly: true;
  sameSite: "lax";
  expirationDate: number;
}

export interface PrimingCookieStore {
  kind: "browser-context" | "web-contents-session";
  set(cookies: readonly PersistentAuthCookie[]): Promise<void>;
}

export function persistentAuthCookies(
  header: string,
  origin: string,
  nowMs: number,
): PersistentAuthCookie[] {
  if (!Number.isFinite(nowMs)) throw new Error("Synthetic auth cookies need a finite clock");
  const expires = Math.floor(nowMs / 1000) + SYNTHETIC_AUTH_LIFETIME_SECONDS;
  return header
    .split("; ")
    .filter(Boolean)
    .map((entry) => {
      const split = entry.indexOf("=");
      if (split <= 0) throw new Error("Malformed synthetic auth cookie");
      return {
        name: entry.slice(0, split),
        value: entry.slice(split + 1),
        url: origin,
        path: "/" as const,
        httpOnly: true as const,
        sameSite: "Lax" as const,
        expires,
      };
    });
}

export function electronAuthCookie(cookie: PersistentAuthCookie): ElectronAuthCookie {
  if (!Number.isFinite(cookie.expires) || cookie.expires <= 0)
    throw new Error("Desktop auth cookies require a persistent expiry");
  return {
    url: cookie.url,
    name: cookie.name,
    value: cookie.value,
    path: cookie.path,
    httpOnly: true,
    sameSite: "lax",
    expirationDate: cookie.expires,
  };
}

/** The default browser context is not the per-origin persist partition. */
export function selectPrimingCookieStore(stores: {
  browserContext: PrimingCookieStore;
  webContentsSession: PrimingCookieStore | null;
}): PrimingCookieStore {
  const selected = stores.webContentsSession;
  if (selected?.kind !== "web-contents-session")
    throw new Error("Desktop priming requires the window session");
  return selected;
}
