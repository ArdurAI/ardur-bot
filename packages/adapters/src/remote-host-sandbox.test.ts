import fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetServiceSecretsMemo } from "@ardurbot/core/node/service-secrets";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostClient } from "./remote-host-sandbox.js";

const KEY = `fake-encryption-marker-${"b".repeat(12)}`;

const roots: string[] = [];
afterEach(async () => {
  if (typeof resetServiceSecretsMemo === "function") {
    resetServiceSecretsMemo();
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("createHostClient", () => {
  it("reuses the secrets file memo and does not synchronously re-read the file on repeated calls", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "remote-host-client-"));
    roots.push(root);
    const file = path.join(root, "secrets.env");
    await writeFile(file, `ENCRYPTION_KEY=${KEY}\n`, { mode: 0o600 });

    const prevEnv = process.env.ARDURBOT_SECRETS_FILE;
    try {
      process.env.ARDURBOT_SECRETS_FILE = file;
      if (typeof resetServiceSecretsMemo === "function") {
        resetServiceSecretsMemo();
      }
      const readSpy = vi.spyOn(fs, "readFileSync");
      createHostClient();
      createHostClient();
      createHostClient();
      expect(readSpy).toHaveBeenCalledTimes(1);
    } finally {
      if (prevEnv === undefined) delete process.env.ARDURBOT_SECRETS_FILE;
      else process.env.ARDURBOT_SECRETS_FILE = prevEnv;
    }
  });
});
