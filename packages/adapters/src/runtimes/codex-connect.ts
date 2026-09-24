import type { ModelOAuthBegin } from "@ardurbot/contracts";
import { ModelOAuthBeginSchema } from "@ardurbot/contracts";
import type { CodexRpc } from "./codex-app-server-runtime.js";
import { openCodex } from "./codex-app-server-runtime.js";

type Login = {
  owner: string;
  rpc: CodexRpc;
  status: "pending" | "ready" | "error";
  timer: ReturnType<typeof setTimeout>;
};
/** Only login handles and state live here. The vendor process owns authentication. */
export class CodexConnections {
  private logins = new Map<string, Login>();
  constructor(private readonly open = openCodex) {}
  async begin(owner: string): Promise<ModelOAuthBegin> {
    for (const [id, login] of this.logins) if (login.owner === owner) await this.cancel(owner, id);
    const rpc = await this.open();
    try {
      const response = await rpc.request<{ type: string; loginId: string; authUrl: string }>(
        "account/login/start",
        { type: "chatgpt" },
      );
      const url = new URL(response.authUrl);
      if (
        url.protocol !== "https:" ||
        !["auth.openai.com", "auth0.openai.com", "chatgpt.com"].includes(url.hostname)
      )
        throw new Error("Codex returned an unsupported sign-in address.");
      const value = ModelOAuthBeginSchema.parse({
        mode: "auth-url",
        loginId: response.loginId,
        provider: "codex-app-server",
        verificationUri: response.authUrl,
        expiresInSeconds: 300,
      });
      const timer = setTimeout(() => {
        void this.cancel(owner, response.loginId);
      }, 300_000);
      timer.unref();
      const login: Login = { owner, rpc, status: "pending", timer };
      this.logins.set(response.loginId, login);
      void (async () => {
        try {
          for await (const message of rpc.events) {
            if (
              message.method === "account/login/completed" &&
              message.params?.loginId === response.loginId
            ) {
              login.status = message.params.success === true ? "ready" : "error";
              await rpc.close();
              break;
            }
          }
        } catch {
          if (login.status === "pending") login.status = "error";
        }
      })();
      return value;
    } catch {
      await rpc.close();
      throw new Error("Codex app-server unavailable");
    }
  }
  status(owner: string, id: string) {
    const login = this.logins.get(id);
    if (!login || login.owner !== owner) throw new Error("Sign-in expired. Connect Codex again.");
    return login.status === "error"
      ? { status: "error" as const, error: "Codex sign-in did not finish. Connect again." }
      : { status: login.status };
  }
  async cancel(owner: string, id: string) {
    const login = this.logins.get(id);
    if (!login || login.owner !== owner) return;
    this.logins.delete(id);
    clearTimeout(login.timer);
    if (login.status === "pending")
      await login.rpc.request("account/login/cancel", { loginId: id }).catch(() => undefined);
    await login.rpc.close();
  }
}
