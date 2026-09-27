type OwnerSession = { userId: string; sessionId: string };

export function createDeploymentOwnerFixture(options: {
  authenticate: (request: Request) => Promise<OwnerSession | null>;
  setOwner: (userId: string) => Promise<void>;
  waitMs?: number;
  leaseMs?: number;
}) {
  const waitMs = options.waitMs ?? 120_000;
  const leaseMs = options.leaseMs ?? 180_000;
  let lease: { sessionId: string; expiresAt: number } | undefined;
  const waiters = new Set<() => void>();
  const wakeWaiters = () => {
    for (const wake of waiters) wake();
  };

  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST" && request.method !== "DELETE") {
      return new Response(null, { status: 405 });
    }
    const session = await options.authenticate(request);
    if (!session) return new Response(null, { status: 401 });

    if (request.method === "DELETE") {
      if (lease?.sessionId !== session.sessionId) return new Response(null, { status: 403 });
      lease = undefined;
      wakeWaiters();
      return new Response(null, { status: 204 });
    }

    const deadline = Date.now() + waitMs;
    for (;;) {
      const now = Date.now();
      if (lease && lease.expiresAt <= now) {
        lease = undefined;
        wakeWaiters();
      }
      if (!lease || lease.sessionId === session.sessionId) {
        const previous = lease;
        const claimedLease = { sessionId: session.sessionId, expiresAt: now + leaseMs };
        lease = claimedLease;
        try {
          await options.setOwner(session.userId);
        } catch (error) {
          if (lease === claimedLease) {
            lease = previous;
            if (!previous) wakeWaiters();
          }
          throw error;
        }
        return Response.json({ ok: true });
      }
      const remaining = Math.min(deadline - now, lease.expiresAt - now);
      if (remaining <= 0) return new Response(null, { status: 423 });
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          waiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, remaining);
        waiters.add(wake);
      });
    }
  };
}
