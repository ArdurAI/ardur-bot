import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext, SandboxProvider } from "@ardurbot/adapter-kit";
import type { RemoteComputerCall } from "@ardurbot/contracts";
import { ComputerConnectionSettingsSchema } from "@ardurbot/contracts";
import { expect, it, vi } from "vitest";
import { EncryptedSecretStore } from "./secret-store.js";
import { FleetService } from "./service.js";

const context: AdapterContext = {
  operationId: "operation",
  traceId: "operation",
  userId: "owner",
  spaceId: "space",
  signal: new AbortController().signal,
};
const settings = ComputerConnectionSettingsSchema.parse({
  engine: "ssh",
  ssh: { host: "computer.invalid", user: "runner" },
});

it("preserves provision network policy and file preview options at the host boundary", async () => {
  const service = new FleetService("/unused", "fixture-encryption-material");
  const provision = vi.fn(async () => ({}));
  const readFile = vi.fn(async () => new Uint8Array());
  vi.spyOn(service, "provider").mockReturnValue({
    describe: () => ({ id: "remote-docker" }),
    provision,
    readFile,
  } as unknown as SandboxProvider);
  const operation: RemoteComputerCall = {
    op: "computer.remote.call",
    connectionId: "connection",
    homeKey: "home",
    settings: ComputerConnectionSettingsSchema.parse({ engine: "docker" }),
    action: { type: "provision", imageProfile: "base", networkEgress: false },
  };
  await service.call(operation, context, vi.fn());
  expect(provision).toHaveBeenCalledWith(
    expect.objectContaining({ networkEgress: false }),
    context,
  );
  await service.call(
    { ...operation, action: { type: "files.read", path: "notes.txt", maxBytes: 2, preview: true } },
    context,
    vi.fn(),
  );
  expect(readFile).toHaveBeenCalledWith(expect.any(Object), "notes.txt", context, {
    maxBytes: 2,
    preview: true,
  });
});

it("binds terminal control to its connection, home, space and unexpired lease", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "fleet-service-"));
  const service = new FleetService(root, "fixture-encryption-material");
  const terminal = {
    open: vi.fn(async () => ({ id: "session", generation: "generation" })),
    write: vi.fn(async () => undefined),
  };
  vi.spyOn(service, "provider").mockReturnValue({
    describe: () => ({ id: "ssh" }),
    terminal,
  } as unknown as SandboxProvider);
  const operation: RemoteComputerCall = {
    op: "computer.remote.call",
    connectionId: "connection",
    homeKey: "home",
    settings,
    action: {
      type: "terminal.open",
      leaseId: "lease",
      fence: 1,
      generation: "generation",
      expiresAt: Date.now() + 60000,
      cols: 80,
      rows: 24,
      shellProfileId: "default",
      workingRoot: "",
    },
  };
  try {
    await service.call(operation, context, vi.fn());
    const write = {
      ...operation,
      action: {
        type: "terminal.write" as const,
        sessionId: "session",
        leaseId: "lease",
        content: "b2s=",
      },
    };
    await service.call(write, context, vi.fn());
    expect(terminal.write).toHaveBeenCalledOnce();
    for (const changed of [
      { ...write, homeKey: "another" },
      { ...write, connectionId: "another" },
      { ...write, action: { ...write.action, leaseId: "another" } },
    ])
      await expect(service.call(changed, context, vi.fn())).rejects.toThrow("lease");
    await expect(service.call(write, { ...context, spaceId: "another" }, vi.fn())).rejects.toThrow(
      "lease",
    );
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61000);
    await expect(service.call(write, context, vi.fn())).rejects.toThrow("lease");
    expect(terminal.write).toHaveBeenCalledOnce();
  } finally {
    vi.restoreAllMocks();
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("imports host-local key material into encrypted storage and returns only an opaque id", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "fleet-service-"));
  const service = new FleetService(root, "fixture-encryption-material");
  const file = path.join(root, "key");
  try {
    await writeFile(file, "fixture-private-material", { mode: 0o600 });
    const result = await service.importSecret(
      {
        op: "computer.remote.secret",
        grantId: "grant",
        privateKeyPath: file,
      },
      context,
    );
    expect(Object.keys(result)).toEqual(["id"]);
    const stored = path.join(root, "fleet-secrets", result.id);
    const ciphertext = await readFile(stored, "utf8");
    expect(ciphertext).not.toContain("fixture-private-material");
    expect((await stat(stored)).mode & 0o777).toBe(0o600);
    const secrets = new EncryptedSecretStore("fixture-encryption-material");
    expect(JSON.parse(secrets.load(ciphertext, result.id))).toEqual({
      privateKey: "fixture-private-material",
    });
    expect(() => secrets.load(ciphertext, "different-record")).toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
