import { randomBytes, randomUUID } from "node:crypto";
import { EncryptedSecretStore, McpOAuthBroker } from "@ardurbot/adapters";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntegrationConnections } from "./integration-connections.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const actor = { spaceId: "space", userId: "owner" };
const endpoint = "https://mcp.example.test/mcp";
const redirectUri = "https://app.example.test/api/oauth/done";

type Row = Record<string, unknown>;

/** In-memory rows. Updates bump updatedAt the way Prisma @updatedAt does, and callers receive copies. */
function memoryDb() {
  let clock = Date.parse("2026-09-25T12:00:00.000Z");
  const order: string[] = [];
  let loggedRead = false;
  const binds: Row[] = [];
  let reservations = 0;
  let holdFirstReservation = false;
  let releaseReservation: (() => void) | undefined;
  let reservationEntered: (() => void) | undefined;
  const reservationStarted = new Promise<void>((resolve) => {
    reservationEntered = resolve;
  });
  let holdProbe = false;
  let probeHolds = 0;
  let releaseProbe: (() => void) | undefined;
  let probeEntered: (() => void) | undefined;
  const probeStarted = new Promise<void>((resolve) => {
    probeEntered = resolve;
  });
  const row: Row = {
    id: "connection",
    ...actor,
    slug: "custom-mcp",
    name: "Custom",
    transport: "streamable_http",
    endpoint,
    enabled: true,
    revision: 1,
    catalogId: null,
    imported: null,
    connectionState: "not-connected",
    pendingOauthSessionId: null,
    secretId: null,
    updatedAt: new Date(clock),
    consentStartedAt: null,
    lastError: null,
    recentErrors: [],
    manifest: null,
    spaceAllowedTools: [],
    spaceToolPolicies: {},
    resourceConstraints: {},
  };
  const secretRows = new Map<string, { id: string; ciphertext: string }>();
  const sessions: Row[] = [];
  let afterSession: (() => void) | undefined;

  function bump() {
    clock += 1000;
    row.updatedAt = new Date(clock);
  }
  function copy(): Row {
    return { ...row, updatedAt: new Date((row.updatedAt as Date).getTime()) };
  }
  function matches(where: Row, target: Row) {
    return Object.entries(where).every(([key, expected]) => {
      if (expected instanceof Date) return (target[key] as Date).getTime() === expected.getTime();
      if (expected && typeof expected === "object") return true;
      return (target[key] ?? null) === (expected ?? null);
    });
  }
  function apply(data: Row) {
    const next = { ...data };
    const revision = next.revision;
    if (revision && typeof revision === "object" && "increment" in revision) {
      row.revision = (row.revision as number) + Number(revision.increment);
      delete next.revision;
    }
    Object.assign(row, next);
    bump();
  }

  const db = {
    mcpServer: {
      // One row stands in for each new catalog server a connect creates.
      create: vi.fn(async ({ data }: { data: Row }) => {
        Object.assign(row, { pendingOauthSessionId: null, secretId: null, revision: 1 }, data);
        bump();
        return copy();
      }),
      findFirst: vi.fn(async ({ where }: { where: Row }) => {
        if (!loggedRead) {
          loggedRead = true;
          order.push("read");
        }
        return matches(where, row) ? copy() : null;
      }),
      update: vi.fn(async ({ data }: { data: Row }) => {
        const persistingSecret = typeof data.secretId === "string";
        apply(data);
        if (holdProbe && persistingSecret) {
          probeHolds += 1;
          if (probeHolds === 1) {
            probeEntered?.();
            await new Promise<void>((resolve) => {
              releaseProbe = resolve;
            });
          }
        }
        return copy();
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const reserving =
          typeof data.pendingOauthSessionId === "string" && data.pendingOauthSessionId.length > 0;
        const persistingSecret = typeof data.secretId === "string";
        if (reserving) {
          reservations += 1;
          binds.push(where);
          if (reservations === 1 && holdFirstReservation) {
            reservationEntered?.();
            await new Promise<void>((resolve) => {
              releaseReservation = resolve;
            });
          }
        }
        if (holdProbe && persistingSecret) {
          probeHolds += 1;
          if (probeHolds === 1) {
            probeEntered?.();
            await new Promise<void>((resolve) => {
              releaseProbe = resolve;
            });
          }
        }
        if (!matches(where, row)) return { count: 0 };
        apply(data);
        if (reserving) order.push("bind");
        return { count: 1 };
      }),
    },
    secret: {
      create: vi.fn(async ({ data }: { data: { id: string; ciphertext: string } }) => {
        secretRows.set(data.id, data);
        return data;
      }),
      findFirst: vi.fn(
        async ({ where }: { where: { id?: string } }) => secretRows.get(where.id ?? "") ?? null,
      ),
      deleteMany: vi.fn(async ({ where }: { where: { id?: string } }) => {
        return { count: where.id && secretRows.delete(where.id) ? 1 : 0 };
      }),
    },
    mcpOAuthSession: {
      count: vi.fn(async () => sessions.length),
      findFirst: vi.fn(async ({ where }: { where: Row }) => {
        return (
          sessions.find((session) =>
            Object.entries(where).every(([key, expected]) => {
              if (expected && typeof expected === "object" && "gte" in expected)
                return (session[key] as Date).getTime() >= (expected.gte as Date).getTime();
              if (expected && typeof expected === "object" && "lt" in expected)
                return (session[key] as Date).getTime() < (expected.lt as Date).getTime();
              return (session[key] ?? null) === (expected ?? null);
            }),
          ) ?? null
        );
      }),
      create: vi.fn(async ({ data }: { data: Row }) => {
        sessions.push({ ...data, createdAt: new Date() });
        const created = sessions.at(-1);
        afterSession?.();
        return created;
      }),
      deleteMany: vi.fn(async ({ where }: { where: Row }) => {
        const before = sessions.length;
        for (let index = sessions.length - 1; index >= 0; index -= 1) {
          const session = sessions[index]!;
          const drop = Object.entries(where).every(([key, expected]) => {
            if (expected && typeof expected === "object" && "lt" in expected)
              return (session[key] as Date).getTime() < (expected.lt as Date).getTime();
            return (session[key] ?? null) === (expected ?? null);
          });
          if (drop) sessions.splice(index, 1);
        }
        return { count: before - sessions.length };
      }),
    },
    $executeRaw: vi.fn(async () => 1),
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (callback: (tx: typeof db) => unknown) => callback(db));
  return {
    db,
    order,
    binds,
    sessions,
    secretRows,
    row: copy,
    holdFirstReservation() {
      holdFirstReservation = true;
    },
    reservationStarted,
    releaseReservation() {
      releaseReservation?.();
    },
    probeStarted,
    holdProbe() {
      holdProbe = true;
    },
    afterSession(hook: (() => void) | undefined) {
      afterSession = hook;
    },
    reserve(sessionId: string) {
      row.pendingOauthSessionId = sessionId;
      bump();
    },
    releaseProbe() {
      releaseProbe?.();
    },
  };
}

function oauthFetch(resource = endpoint) {
  const resourceUrl = new URL(resource);
  const metadata = `${resourceUrl.origin}/.well-known/oauth-protected-resource${resourceUrl.pathname}`;
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const host = new Headers(input instanceof Request ? input.headers : init?.headers).get("host");
    if (host) url.host = host;
    if (url.href === resource && request.method === "POST") {
      return new Response(null, {
        status: 401,
        headers: { "WWW-Authenticate": `Bearer resource_metadata="${metadata}"` },
      });
    }
    if (url.href === metadata) {
      return Response.json({
        resource,
        authorization_servers: ["https://auth.example.test"],
      });
    }
    if (url.href === "https://auth.example.test/.well-known/oauth-authorization-server") {
      return Response.json({
        issuer: "https://auth.example.test",
        authorization_endpoint: "https://auth.example.test/authorize",
        token_endpoint: "https://auth.example.test/token",
        registration_endpoint: "https://auth.example.test/register",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.href === "https://auth.example.test/register" && request.method === "POST") {
      return Response.json(
        {
          client_id: "registered-client-id",
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: "none",
        },
        { status: 201 },
      );
    }
    throw new Error(`Unexpected request: ${request.method} ${url.href}`);
  });
}

/** Keeps ciphertext readable; each real encryption derives a key, which a long loop cannot afford. */
const plainStore = {
  put: async (plaintext: string, _context: never, id?: string) => ({
    id: id ?? randomUUID(),
    ciphertext: plaintext,
  }),
  load: (ciphertext: string) => ciphertext,
};

function harness(resource = endpoint, options: { plainSecrets?: boolean } = {}) {
  const memory = memoryDb();
  const store = options.plainSecrets
    ? plainStore
    : new EncryptedSecretStore(randomBytes(32).toString("hex"));
  const secrets = {
    put: async (plaintext: string, context: never, id?: string) => {
      if (plaintext.includes('"codeVerifier"') && !memory.order.includes("verifier"))
        memory.order.push("verifier");
      return store.put(plaintext, context, id);
    },
    load: (ciphertext: string, id: string) => store.load(ciphertext, id),
  };
  const network = {
    fetch: (input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, init),
    resolveHostname: async () => [{ address: "203.0.113.10", family: 4 as const }],
  };
  vi.stubGlobal("fetch", oauthFetch(resource));
  const oauth = new McpOAuthBroker(memory.db as never, secrets as never, network);
  const service = new IntegrationConnections(
    memory.db as never,
    oauth,
    secrets as never,
    "https://app.example.test",
    network,
  );
  return { ...memory, secrets, service, oauth };
}

const input = { serverId: "connection", redirectUri };

describe("MCP sign-in bind through real provider persistence", () => {
  it("stores the pending id when the probe writes the PKCE verifier", async () => {
    const f = harness();
    const result = await f.service.beginAuthorization(actor, input);
    expect(result, `operations: ${f.order.join(" > ")}`).toMatchObject({
      status: "authorization_required",
    });
    if (result.status !== "authorization_required") throw new Error("sign-in was not requested");
    expect(f.row().pendingOauthSessionId).toBe(result.sessionId);
    // The reservation is stored before the probe writes the PKCE verifier.
    // On the previous tree the log was "read > verifier" and the later bind,
    // which still required that earlier updatedAt, matched nothing.
    expect(f.order).toEqual(["read", "bind", "verifier"]);
    for (const where of f.binds) expect(where).not.toHaveProperty("updatedAt");
    const material = [...f.secretRows.values()].map((secret) =>
      JSON.parse(f.secrets.load(secret.ciphertext, secret.id)),
    );
    expect(material.some((value) => typeof value.oauth?.codeVerifier === "string")).toBe(true);
  });

  it("writes the verifier only while the reserved attempt still holds the pending id", async () => {
    const f = harness();
    const sessionId = "attempt";
    const reserved = await f.db.mcpServer.updateMany({
      where: { id: "connection", pendingOauthSessionId: null },
      data: { pendingOauthSessionId: sessionId },
    });
    expect(reserved.count).toBe(1);
    const started = await f.oauth.begin({
      serverId: "connection",
      ...actor,
      redirectUri,
      sessionId,
    });
    expect(started.status).toBe("authorization_required");
    const stale = await f.db.mcpServer.updateMany({
      where: {
        id: "connection",
        ...actor,
        enabled: true,
        pendingOauthSessionId: null,
      },
      data: { pendingOauthSessionId: "other" },
    });
    expect(stale.count).toBe(0);
    expect(f.row().pendingOauthSessionId).toBe(sessionId);
    expect(f.binds.every((where) => !Object.hasOwn(where, "updatedAt"))).toBe(true);
    const material = [...f.secretRows.values()].map((secret) =>
      JSON.parse(f.secrets.load(secret.ciphertext, secret.id)),
    );
    expect(material.some((value) => typeof value.oauth?.codeVerifier === "string")).toBe(true);
  });

  it("lets a newer begin replace an older one still inside the probe, and does not probe a lost reservation", async () => {
    const f = harness();
    f.holdFirstReservation();
    const older = f.service.beginAuthorization(actor, input);
    await f.reservationStarted;
    const newer = await f.service.beginAuthorization(actor, input);
    f.releaseReservation();
    const first = await older;
    expect(first).toEqual({ status: "replaced" });
    expect(newer).toMatchObject({ status: "authorization_required" });
    if (newer.status !== "authorization_required") throw new Error("sign-in was not requested");
    expect(f.row().pendingOauthSessionId).toBe(newer.sessionId);
    expect(f.sessions).toHaveLength(1);
    expect(f.sessions[0]).toMatchObject({ id: newer.sessionId });
    for (const where of f.binds) expect(where).not.toHaveProperty("updatedAt");
  });

  it("drops a losing probe's verifier writes and keeps the winner's secret after cancel", async () => {
    const f = harness();
    f.holdProbe();
    const older = f.service.beginAuthorization(actor, input);
    await f.probeStarted;
    const newer = await f.service.beginAuthorization(actor, input);
    f.releaseProbe();
    const first = await older;
    expect(first).toEqual({ status: "replaced" });
    expect(newer).toMatchObject({ status: "authorization_required" });
    if (newer.status !== "authorization_required") throw new Error("sign-in was not requested");
    const winnerSession = f.sessions.find((session) => session.id === newer.sessionId);
    expect(winnerSession).toBeDefined();
    const winnerMaterial = JSON.parse(
      f.secrets.load(String(winnerSession?.oauthCiphertext), newer.sessionId),
    ) as { oauth?: { codeVerifier?: string } };
    const winnerVerifier = winnerMaterial.oauth?.codeVerifier;
    expect(typeof winnerVerifier).toBe("string");
    const stored = f.secretRows.get(String(f.row().secretId));
    expect(stored).toBeDefined();
    const serverMaterial = JSON.parse(f.secrets.load(stored!.ciphertext, stored!.id)) as {
      oauth?: { codeVerifier?: string };
    };
    expect(serverMaterial.oauth?.codeVerifier).toBe(winnerVerifier);
    expect(f.sessions.map((session) => session.id)).toEqual([newer.sessionId]);
    await f.service.cancelAuthorization(actor, {
      serverId: "connection",
      sessionId: newer.sessionId,
    });
    expect(f.row().pendingOauthSessionId).toBeNull();
    expect(f.row().connectionState).toBe("not-connected");
    const afterCancel = f.secretRows.get(String(f.row().secretId));
    expect(afterCancel).toBeDefined();
    const cancelledMaterial = JSON.parse(
      f.secrets.load(afterCancel!.ciphertext, afterCancel!.id),
    ) as { oauth?: { codeVerifier?: string } };
    expect(cancelledMaterial.oauth?.codeVerifier).toBe(winnerVerifier);
  });

  it("replaces an older begin that is still inside the probe", async () => {
    const f = harness();
    f.holdProbe();
    const older = f.service.beginAuthorization(actor, input);
    await f.probeStarted;
    const newer = await f.service.beginAuthorization(actor, input);
    f.releaseProbe();
    const first = await older;
    expect(first).toEqual({ status: "replaced" });
    expect(newer).toMatchObject({ status: "authorization_required" });
    if (newer.status !== "authorization_required") throw new Error("sign-in was not requested");
    expect(f.row().pendingOauthSessionId).toBe(newer.sessionId);
    expect(f.sessions).toHaveLength(1);
    expect(f.sessions[0]).toMatchObject({ id: newer.sessionId });
    for (const where of f.binds) expect(where).not.toHaveProperty("updatedAt");
  });

  it("starts a fresh attempt after the older sign-in has finished", async () => {
    const f = harness();
    const older = await f.service.beginAuthorization(actor, input);
    expect(older, `operations: ${f.order.join(" > ")}`).toMatchObject({
      status: "authorization_required",
    });
    if (older.status !== "authorization_required") throw new Error("sign-in was not requested");
    await f.service.cancelAuthorization(actor, {
      serverId: "connection",
      sessionId: older.sessionId,
    });
    expect(f.row().pendingOauthSessionId).toBeNull();
    const newer = await f.service.beginAuthorization(actor, input);
    expect(newer).toMatchObject({ status: "authorization_required" });
    if (newer.status !== "authorization_required") throw new Error("sign-in was not requested");
    expect(newer.sessionId).not.toBe(older.sessionId);
    expect(f.row().pendingOauthSessionId).toBe(newer.sessionId);
    for (const where of f.binds) expect(where).not.toHaveProperty("updatedAt");
  });

  it("drops each replaced catalog connect, so 101 rapid clicks stay under the pending cap", async () => {
    const f = harness("https://mcp.notion.com/mcp", { plainSecrets: true });
    let click = 0;
    // A newer click reserves the sign-in right after this attempt stores its session.
    f.afterSession(() => f.reserve(`newer-click-${click}`));
    for (click = 1; click <= 101; click += 1) {
      const result = await f.service.connect(actor, { catalogId: "notion" });
      expect(result, `click ${click}`).toMatchObject({ status: "replaced", sessionId: null });
      expect(f.sessions, `click ${click}`).toEqual([]);
    }
    f.afterSession(undefined);
    const last = await f.service.connect(actor, { catalogId: "notion" });
    expect(last.authorizationUrl).toEqual(expect.any(String));
    expect(f.sessions.map((session) => session.id)).toEqual([last.sessionId]);
    expect(f.row().pendingOauthSessionId).toBe(last.sessionId);
  });
});
