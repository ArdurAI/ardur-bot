import type { TerminalContext, TerminalProvider } from "./terminal.js";
import type { AdapterContext, ComputerRef } from "./types.js";

/** Keep a session on the provider that opened it, even when destination settings change. */
export function routedTerminal(
  owner: (computer: ComputerRef, context: AdapterContext) => Promise<TerminalProvider | undefined>,
): TerminalProvider {
  type Route = {
    provider?: TerminalProvider;
    computer: ComputerRef;
    context: TerminalContext;
    cancelled: boolean;
    done?: Promise<unknown>;
  };
  const sessions = new Map<string, Route>();
  const pending = new Set<Route>();
  const session = (id: string) => {
    const route = sessions.get(id);
    if (!route?.provider) throw new Error("Terminal session is unavailable.");
    return route.provider;
  };
  return {
    available: async (computer, context) => {
      const provider = await owner(computer, context);
      return !!provider && ((await provider.available?.(computer, context)) ?? true);
    },
    open: (computer, options, context) => {
      const route: Route = { computer, context: { ...context }, cancelled: false };
      pending.add(route);
      const opening = (async () => {
        const provider = await owner(computer, context);
        route.provider = provider;
        if (
          route.cancelled ||
          !provider ||
          (provider.available && !(await provider.available(computer, context)))
        )
          throw new Error("Not available on this computer");
        if (route.cancelled) throw new Error("Terminal lease is unavailable.");
        const opened = await provider.open(computer, options, context);
        sessions.set(opened.id, route);
        if (route.cancelled) {
          await provider.close(opened.id, "revoked-during-open");
          sessions.delete(opened.id);
          throw new Error("Terminal lease is unavailable.");
        }
        return opened;
      })().finally(() => pending.delete(route));
      route.done = opening;
      return opening;
    },
    write: async (id, bytes) => session(id).write(id, bytes),
    resize: async (id, cols, rows) => session(id).resize(id, cols, rows),
    close: async (id, reason) => {
      const provider = sessions.get(id)?.provider;
      if (!provider) return;
      await provider.close(id, reason);
      sessions.delete(id);
    },
    output: (id) => session(id).output(id),
    revoke: async (computer, leaseId, context) => {
      const matches = (route: Route) =>
        route.computer.id === computer.id &&
        route.context.spaceId === context.spaceId &&
        route.context.userId === context.userId &&
        (leaseId === "*" || route.context.leaseId === leaseId);
      const opening = [...pending].filter(matches);
      for (const route of opening) route.cancelled = true;
      const routes = [...sessions.values(), ...opening].filter(matches);
      const providers = new Set(
        routes.map((route) => route.provider).filter((provider) => provider !== undefined),
      );
      if (!routes.length) {
        const provider = await owner(computer, context);
        if (provider) providers.add(provider);
      }
      await Promise.all(
        [...providers].map((provider) => provider.revoke(computer, leaseId, context)),
      );
      await Promise.all(opening.map((route) => route.done?.catch(() => undefined)));
      for (const [id, route] of sessions)
        if (matches(route)) {
          await route.provider?.close(id, "revoked");
          sessions.delete(id);
        }
    },
  };
}
