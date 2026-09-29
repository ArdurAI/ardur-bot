import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hermesInstallJob } from "@ardurbot/adapter-kit";
import { NATIVE_HOST_OWNER_MESSAGE } from "@ardurbot/adapters";
import type { Actor } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import {
  HERMES_INSTALL_PHASES,
  HERMES_SOURCE_PIN,
  HERMES_SOURCE_TREE,
  type HermesInstallPhase,
} from "@ardurbot/host-runtime/runtimes/hermes-install";
import {
  HERMES_INSTALL_ALREADY,
  HERMES_INSTALL_BRIDGE,
  HERMES_INSTALL_RUNNING,
} from "@ardurbot/host-runtime/runtimes/hermes-installer";
import { RPCHandler } from "@orpc/server/fetch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

vi.mock("../../../packages/host-runtime/python/hermes_sources.json", () => ({ default: {} }));

const actor = {
  spaceId: "workspace-1",
  userId: "user-1",
  email: "user@ardurbot.test",
  isDeploymentOwner: true,
} satisfies Actor;

describe("Hermes install action", () => {
  let data = "";
  const roots: string[] = [];

  beforeEach(async () => {
    data = await mkdtemp(path.join(tmpdir(), "hermes-install-api-"));
    roots.push(data);
    vi.stubEnv("DATA_DIR", data);
    vi.stubEnv("ARDUR_HERMES_INSTALL", "");
    vi.stubEnv("ARDURBOT_HOST_BRIDGE", "");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  function hermesRoot(): string {
    return path.join(path.resolve(data), "hermes");
  }

  async function writeStatus(
    state: "installing" | "ready" | "failed",
    phase?: HermesInstallPhase,
  ): Promise<void> {
    await mkdir(hermesRoot(), { recursive: true });
    await writeFile(
      path.join(hermesRoot(), "install-status.json"),
      JSON.stringify({
        state,
        ...(phase ? { phase } : {}),
        message: "Status.",
        updatedAt: "2026-01-02T03:04:05.000Z",
      }),
    );
  }

  async function writeLock(pid: number, ageMs = 0): Promise<void> {
    const lock = path.join(hermesRoot(), "runtimes", ".install.lock");
    await mkdir(path.dirname(lock), { recursive: true });
    await writeFile(lock, JSON.stringify({ pid, createdAt: "2026-01-02T03:04:05.000Z" }));
    if (ageMs > 0) {
      const when = new Date(Date.now() - ageMs);
      await utimes(lock, when, when);
    }
  }

  async function writeQualified(): Promise<void> {
    const managed = path.join(hermesRoot(), "runtimes", "hermes-agent");
    await mkdir(path.join(managed, ".venv", "bin"), { recursive: true });
    await writeFile(path.join(managed, ".venv", "bin", "python"), "fixture");
    await writeFile(
      path.join(managed, ".ardur-install.json"),
      JSON.stringify({ pin: HERMES_SOURCE_PIN, tree: HERMES_SOURCE_TREE }),
    );
  }

  function harness(users: { id: string }[] = [{ id: actor.userId }]) {
    const enqueue = vi.fn(async () => undefined);
    const prisma = {
      user: { findMany: vi.fn(async () => users) },
      hostRegistration: {
        findUnique: vi.fn(async () => ({ id: "default", userId: actor.userId })),
      },
      spaceModelPreference: { findMany: vi.fn(async () => []) },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      jobs: { enqueue },
      env: { sandboxProvider: "fake" },
      hostBridge: {
        status: vi.fn(async () => ({
          connected: true,
          health: {
            capabilities: { providerRelay: 1 },
            hermes: {
              runtimeKind: "hermes",
              available: false,
              models: [],
              reason: "Hermes is not installed on this computer.",
            },
          },
        })),
      },
    } as unknown as RouterDeps;
    const handler = new RPCHandler(createRouter(deps));
    const rpc = async (method: string, input: unknown) => {
      const result = await handler.handle(
        new Request(`http://127.0.0.1/rpc/runtimes/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: input }),
        }),
        { prefix: "/rpc", context: { actor } },
      );
      if (!result.matched) throw new Error(`Unmatched ${method}`);
      return result.response;
    };
    return { enqueue, rpc };
  }

  async function body(response: Response): Promise<{ json: Record<string, unknown> }> {
    return response.json();
  }

  it("refuses install for a non-owner", async () => {
    const { enqueue, rpc } = harness([{ id: "other" }, { id: actor.userId }]);
    const response = await rpc("installHermes", {});
    expect(response.status).toBe(403);
    expect(await body(response)).toEqual({
      json: expect.objectContaining({
        code: "FORBIDDEN",
        message: NATIVE_HOST_OWNER_MESSAGE,
      }),
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("refuses install in bridge mode", async () => {
    vi.stubEnv("ARDURBOT_HOST_BRIDGE", "api");
    const { enqueue, rpc } = harness();
    const response = await rpc("installHermes", {});
    expect(response.status).toBe(403);
    expect(await body(response)).toEqual({
      json: expect.objectContaining({ code: "FORBIDDEN", message: HERMES_INSTALL_BRIDGE }),
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("refuses install when Hermes is already ready", async () => {
    await writeQualified();
    const { enqueue, rpc } = harness();
    const response = await rpc("installHermes", {});
    expect(response.status).toBe(409);
    expect(await body(response)).toEqual({
      json: expect.objectContaining({ code: "CONFLICT", message: HERMES_INSTALL_ALREADY }),
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("refuses install while a lock is held", async () => {
    await writeLock(process.pid);
    const { enqueue, rpc } = harness();
    const response = await rpc("installHermes", {});
    expect(response.status).toBe(409);
    expect(await body(response)).toEqual({
      json: expect.objectContaining({ code: "CONFLICT", message: HERMES_INSTALL_RUNNING }),
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("refuses a path, url, or version on install", async () => {
    const { enqueue, rpc } = harness();
    const response = await rpc("installHermes", { path: "no", url: "no", version: "no" });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("enqueues one local install for the owner", async () => {
    const { enqueue, rpc } = harness();
    const response = await rpc("installHermes", {});
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ json: { ok: true } });
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(hermesInstallJob());
  });

  it("offers install only to the local owner when Hermes is not installed", async () => {
    const { rpc } = harness();
    const response = await rpc("availability", { runtimeKind: "hermes" });
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({
      json: expect.objectContaining({
        runtimeKind: "hermes",
        available: false,
        reason: "Hermes is not installed on this computer.",
        install: { state: "absent" },
      }),
    });
  });

  it("offers reinstall when the managed install fails its safety check", async () => {
    const managed = path.join(hermesRoot(), "runtimes", "hermes-agent");
    await mkdir(managed, { recursive: true });
    await writeFile(path.join(managed, ".env"), "fixture");
    const { rpc } = harness();
    expect(await body(await rpc("availability", { runtimeKind: "hermes" }))).toEqual({
      json: expect.objectContaining({
        available: false,
        reason: "The Hermes install on this computer failed its safety check.",
        install: { state: "absent" },
      }),
    });
  });

  it("never offers install for an explicit install that fails its safety check", async () => {
    const explicit = path.join(data, "elsewhere");
    await mkdir(explicit, { recursive: true });
    await writeFile(path.join(explicit, ".env"), "fixture");
    vi.stubEnv("ARDUR_HERMES_INSTALL", explicit);
    const { rpc } = harness();
    const json = (await body(await rpc("availability", { runtimeKind: "hermes" }))).json;
    expect(json).toEqual(
      expect.objectContaining({
        available: false,
        reason: "The Hermes install on this computer failed its safety check.",
      }),
    );
    expect(json.install).toBeUndefined();
  });

  it("reports each install phase while the lock is held", async () => {
    const { rpc } = harness();
    for (const phase of HERMES_INSTALL_PHASES) {
      await writeLock(process.pid);
      await writeStatus("installing", phase);
      const response = await rpc("availability", { runtimeKind: "hermes" });
      expect(await body(response)).toEqual({
        json: expect.objectContaining({
          available: false,
          install: { state: "installing", phase },
        }),
      });
    }
    await writeLock(process.pid);
    await writeStatus("installing");
    expect(await body(await rpc("availability", { runtimeKind: "hermes" }))).toEqual({
      json: expect.objectContaining({
        install: { state: "installing", phase: "downloading" },
      }),
    });
  });

  it("keeps reporting an install while its live process holds an old lock", async () => {
    const { rpc } = harness();
    await writeLock(process.pid, 2 * 60 * 60 * 1000);
    await writeStatus("installing", "python");
    expect(await body(await rpc("availability", { runtimeKind: "hermes" }))).toEqual({
      json: expect.objectContaining({ install: { state: "installing", phase: "python" } }),
    });
  });

  it("reports a failed install when the lock is stale or the status failed", async () => {
    const { rpc } = harness();
    await writeLock(-1, 2 * 60 * 60 * 1000);
    await writeStatus("installing", "python");
    expect(await body(await rpc("availability", { runtimeKind: "hermes" }))).toEqual({
      json: expect.objectContaining({ install: { state: "failed" } }),
    });
    await writeLock(-1);
    await writeStatus("installing", "packages");
    expect(await body(await rpc("availability", { runtimeKind: "hermes" }))).toEqual({
      json: expect.objectContaining({ install: { state: "failed" } }),
    });
    await rm(path.join(hermesRoot(), "runtimes", ".install.lock"), { force: true });
    await writeStatus("failed");
    expect(await body(await rpc("availability", { runtimeKind: "hermes" }))).toEqual({
      json: expect.objectContaining({ install: { state: "failed" } }),
    });
    await writeStatus("ready");
    expect(await body(await rpc("availability", { runtimeKind: "hermes" }))).toEqual({
      json: expect.objectContaining({ install: { state: "failed" } }),
    });
  });

  it("reports ready only after the managed install qualifies", async () => {
    await writeQualified();
    const { rpc } = harness();
    expect(await body(await rpc("availability", { runtimeKind: "hermes" }))).toEqual({
      json: expect.objectContaining({ runtimeKind: "hermes", available: true, models: [] }),
    });
    expect(
      (await body(await rpc("availability", { runtimeKind: "hermes" }))).json.install,
    ).toBeUndefined();
    await writeStatus("ready");
    expect(await body(await rpc("availability", { runtimeKind: "hermes" }))).toEqual({
      json: expect.objectContaining({
        available: true,
        install: { state: "ready" },
      }),
    });
    expect(
      (await body(await rpc("availability", { runtimeKind: "hermes" }))).json.reason,
    ).toBeUndefined();
  });

  it("omits install progress for a paired host and for anyone who is not the owner", async () => {
    await writeLock(process.pid);
    await writeStatus("installing", "checking");
    vi.stubEnv("ARDURBOT_HOST_BRIDGE", "api");
    const paired = harness();
    const pairedBody = await body(await paired.rpc("availability", { runtimeKind: "hermes" }));
    expect(pairedBody.json.install).toBeUndefined();
    expect(pairedBody.json.reason).toBe("Hermes is not installed on this computer.");
    vi.stubEnv("ARDURBOT_HOST_BRIDGE", "");
    const stranger = harness([{ id: "other" }, { id: actor.userId }]);
    const strangerBody = await body(await stranger.rpc("availability", { runtimeKind: "hermes" }));
    expect(strangerBody.json.install).toBeUndefined();
    expect(strangerBody.json.reason).toBe(NATIVE_HOST_OWNER_MESSAGE);
  });
});
