import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext } from "@ardurbot/adapter-kit";
import { expect, it, vi } from "vitest";
import { EncryptedSecretStore } from "./secret-store.js";
import { FleetService } from "./service.js";

vi.mock("node:fs/promises", async (load) => {
  const fs = await load<typeof import("node:fs/promises")>();
  return { ...fs, realpath: vi.fn(fs.realpath) };
});

it.each([true, false])(
  "fences a stalled import after deletion (abort delivered: %s)",
  async (abort) => {
    const root = await mkdtemp(path.join(tmpdir(), "fleet-cancel-"));
    const key = path.join(root, "key");
    const secretId = "afdf5a2e-09f0-42c9-917e-35c45f34db37";
    const controller = new AbortController();
    const context: AdapterContext = {
      operationId: "import",
      traceId: "import",
      userId: "owner",
      spaceId: "space",
      signal: controller.signal,
    };
    const importingHost = new FleetService(root, "fixture-encryption-material");
    const reconnectedHost = new FleetService(root, "fixture-encryption-material");
    let releaseRead!: () => void;
    const stalled = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let notifyRead!: () => void;
    const reading = new Promise<void>((resolve) => {
      notifyRead = resolve;
    });
    const originalRealpath = vi.mocked(realpath).getMockImplementation()!;
    vi.mocked(realpath).mockImplementation(async (...args) => {
      if (args[0] === key) {
        notifyRead();
        await stalled;
      }
      return originalRealpath(...args);
    });
    try {
      await writeFile(key, "fixture-private-material", { mode: 0o600 });
      const importResult = importingHost.importSecret(
        { op: "computer.remote.secret", grantId: "grant", secretId, privateKeyPath: key },
        context,
      );
      await reading;
      if (abort) controller.abort(new Error("Host connection closed."));
      const deletion = reconnectedHost.deleteSecret(secretId);
      expect(await deletion).toEqual({ ok: true });
      releaseRead();
      await expect(importResult).rejects.toThrow();
      const stored = await readFile(path.join(root, "fleet-secrets", secretId), "utf8");
      expect(() =>
        new EncryptedSecretStore("fixture-encryption-material").load(stored, secretId),
      ).toThrow();
    } finally {
      releaseRead();
      vi.mocked(realpath).mockImplementation(originalRealpath);
      await rm(root, { recursive: true, force: true });
    }
  },
);
