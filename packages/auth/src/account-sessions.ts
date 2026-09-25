import { sessionDeviceLabel } from "@ardurbot/core";
import type { Auth } from "./index.js";

/** Keep revocation tokens on the server; clients identify rows by session id. */
export function accountSessions(auth: Auth) {
  async function current(userId: string, headers: Headers) {
    const session = await auth.api.getSession({ headers, query: { disableCookieCache: true } });
    if (!session || session.user.id !== userId)
      throw new Error("Sign in again to manage sessions.");
    return session;
  }
  return {
    async list(userId: string, headers: Headers) {
      const session = await current(userId, headers);
      const rows = await auth.api.listSessions({ headers });
      return rows
        .filter((row) => row.userId === userId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id))
        .map((row) => ({
          id: row.id,
          device: sessionDeviceLabel(row.userAgent),
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          current: row.id === session.session.id,
        }));
    },
    async revoke(userId: string, headers: Headers, id: string) {
      await current(userId, headers);
      const rows = await auth.api.listSessions({ headers });
      const target = rows.find((row) => row.id === id && row.userId === userId);
      if (target) await auth.api.revokeSession({ headers, body: { token: target.token } });
      return { ok: true as const };
    },
    async revokeOthers(userId: string, headers: Headers) {
      await current(userId, headers);
      await auth.api.revokeOtherSessions({ headers });
      return { ok: true as const };
    },
  };
}
