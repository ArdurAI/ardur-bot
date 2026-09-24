import { randomUUID } from "node:crypto";
import { link, mkdir, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import type { Prisma } from "@ardurbot/db";
import type { EncryptedSecretStore } from "../secrets.js";
import { GitDocumentStore } from "./git-store.js";
import { GitTransport, validateGitBranch, validateGitRemote } from "./git-transport.js";
import { contentHash, MarkdownFiles } from "./markdown-files.js";

export function memoryGitAllowedHosts(): string[] {
  return (process.env.MEMORY_GIT_ALLOWED_HOSTS ?? "github.com")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}
export async function memoryGitMachine(dataDir: string): Promise<string> {
  const directory = path.resolve(dataDir, "memory-git");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const files = new MarkdownFiles(await realpath(directory));
  await files.validateRoot();
  const temporary = await files.resolve(`machine-${randomUUID()}`);
  const file = await files.resolve("machine-id");
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(randomUUID());
    await handle.sync();
    await handle.close();
    try {
      await link(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    await handle.close();
    await unlink(temporary);
  }
  const machine = (await files.read("machine-id")) ?? "";
  if (!/^[a-zA-Z0-9_-]{1,160}$/u.test(machine))
    throw new Error("The memory machine identity is unavailable.");
  return machine;
}
export async function configuredGitStore(
  tx: Prisma.TransactionClient,
  config: { documentSettings: unknown; secretId?: string | null },
  dataDir: string,
  secrets?: Pick<EncryptedSecretStore, "load">,
): Promise<GitDocumentStore> {
  const settings = config.documentSettings as Record<string, string>;
  if (
    !settings ||
    !/^[a-zA-Z0-9_-]{1,160}$/u.test(settings.spaceId ?? "") ||
    !["publish", "propose"].includes(settings.mode ?? "")
  )
    throw new Error("Connect a memory repository first.");
  const remote = validateGitRemote(settings.url!, memoryGitAllowedHosts());
  validateGitBranch(settings.branch!);
  const directory = path.resolve(dataDir, "memory-git");
  const quarantineRoot = path.resolve(dataDir, "memory-git", "quarantine");
  await Promise.all(
    [directory, quarantineRoot].map((dir) => mkdir(dir, { recursive: true, mode: 0o700 })),
  );
  const root = path.join(
    await realpath(directory),
    settings.spaceId!,
    contentHash(remote.url).slice(0, 32),
  );
  const loadCredential = async () => {
    if (!secrets || !config.secretId) throw new Error("Reconnect the memory repository.");
    const record = await tx.secret.findFirst({
      where: { id: config.secretId, spaceId: settings.spaceId, kind: "memory-git" },
    });
    if (!record) throw new Error("Reconnect the memory repository.");
    const value = JSON.parse(secrets.load(record.ciphertext, record.id)) as {
      kind: "token" | "ssh";
      value: string;
      repositoryUrl: string;
    };
    if (
      value.repositoryUrl !== remote.url ||
      !["token", "ssh"].includes(value.kind) ||
      typeof value.value !== "string" ||
      !value.value
    )
      throw new Error("Reconnect the memory repository.");
    return value;
  };
  let loadedCredential: ReturnType<typeof loadCredential> | undefined;
  const credential = () => (loadedCredential ??= loadCredential());
  const transport = new GitTransport({
    root,
    remote,
    knownHosts: process.env.MEMORY_GIT_KNOWN_HOSTS || undefined,
    credential,
  });
  return new GitDocumentStore({
    transport,
    quarantine: new MarkdownFiles(await realpath(quarantineRoot)),
    knownSecrets: async () => [(await credential()).value],
    spaceId: settings.spaceId!,
    machineId: await memoryGitMachine(dataDir),
    branch: settings.branch!,
    mode: settings.mode as "publish" | "propose",
    // All API, worker and location operations already hold lockMemorySpace for this space.
    exclusive: (action) => action(),
  });
}
