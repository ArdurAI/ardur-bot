import { createPrivateKey, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { PairingPayload } from "@ardurbot/contracts";
import { PairingPayloadSchema } from "@ardurbot/contracts";
import { CliError } from "./transport.js";

export type PairedHome = PairingPayload & {
  url: string;
  grantId: string;
  spaceId: string;
  privateKey: string;
};
export function configDirectory(platform = process.platform, env = process.env, home = homedir()) {
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, "ardur");
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "ardur");
  if (platform === "win32") {
    if (!env.APPDATA) throw new CliError("Set APPDATA before pairing.", 3);
    return path.join(env.APPDATA, "ardur");
  }
  return path.join(home, ".config", "ardur");
}
function privateFile(stat: Stats, directory = false) {
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (!directory && stat.nlink !== 1) ||
    (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
  )
    throw new CliError("Protect the Ardur config folder and file so only you can read them.", 2);
}
export async function saveHome(home: PairedHome, directory = configDirectory()) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  privateFile(await lstat(directory), true);
  const temporary = path.join(directory, `.home-${randomUUID()}`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(home));
    await file.sync();
    await file.close();
    await rename(temporary, path.join(directory, "home.json"));
  } finally {
    await file.close();
    await unlink(temporary).catch(() => undefined);
  }
}
export async function loadHome(directory = configDirectory()): Promise<PairedHome> {
  let file: FileHandle | undefined;
  try {
    privateFile(await lstat(directory), true);
    file = await open(
      path.join(directory, "home.json"),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const stat = await file.stat();
    privateFile(stat);
    if (stat.size > 64 * 1024) throw new Error("Invalid config");
    const input = JSON.parse(await file.readFile("utf8"));
    const { url, grantId, spaceId, privateKey, ...payload } = input;
    PairingPayloadSchema.parse(payload);
    if (
      typeof url !== "string" ||
      new URL(url).origin !== url ||
      !payload.hints.includes(url) ||
      typeof grantId !== "string" ||
      !grantId ||
      typeof spaceId !== "string" ||
      !spaceId ||
      typeof privateKey !== "string"
    )
      throw new Error("Invalid config");
    const key = createPrivateKey(privateKey);
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1")
      throw new Error("Invalid key");
    return input as PairedHome;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("Pair this device with your home first.", 2);
  } finally {
    await file?.close();
  }
}
