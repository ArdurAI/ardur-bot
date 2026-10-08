import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { prepareTranscript } from "./transcript.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(await realpath(tmpdir()), "ardur-transcript-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});
it("writes a private redacted JSON record, not credentials, and closes it", async () => {
  const file = await prepareTranscript("check.json", home);
  await file.write({
    prompt: "password=fake-value",
    replyText:
      "Bearer fake-token\n-----BEGIN PRIVATE KEY-----\nfake-private\n-----END PRIVATE KEY-----",
    taskId: "task",
    runId: "run",
    verdict: "pass",
  });
  await file.close();
  const target = path.join(home, "check.json");
  const content = await readFile(target, "utf8");
  expect(content).not.toContain("fake-value");
  expect(content).not.toContain("fake-token");
  expect(content).not.toContain("fake-private");
  expect(JSON.parse(content)).toMatchObject({
    taskId: "task",
    runId: "run",
    verdict: "pass",
    prompt: "password=[Redacted]",
  });
  if (process.platform !== "win32") expect((await lstat(target)).mode & 0o777).toBe(0o600);
  expect((await lstat(target)).nlink).toBe(1);
});
it.each(["../escape.json", "nested/../../escape.json", ""])(
  "refuses unsafe relative path %s",
  async (target) => {
    await expect(prepareTranscript(target, home)).rejects.toThrow(
      "Choose a safe private transcript file.",
    );
  },
);
it("allows an explicit absolute path without writing outside its parent", async () => {
  await mkdir(path.join(home, "explicit"));
  const target = path.join(home, "explicit", "check.json");
  const file = await prepareTranscript(target, path.join(home, "other-home"));
  await file.write({ verdict: "pass" });
  await file.close();
  expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ verdict: "pass" });
});
it("refuses overwriting an existing file", async () => {
  await writeFile(path.join(home, "check.json"), "original");
  await expect(prepareTranscript("check.json", home)).rejects.toThrow();
  expect(await readFile(path.join(home, "check.json"), "utf8")).toBe("original");
});
it("refuses a symlink target and a symlink parent", async () => {
  await writeFile(path.join(home, "original"), "original");
  await symlink(path.join(home, "original"), path.join(home, "check.json"));
  await expect(prepareTranscript("check.json", home)).rejects.toThrow();
  await symlink(home, path.join(home, "alias"), "dir");
  await expect(prepareTranscript("alias/other.json", home)).rejects.toThrow();
  expect(await readFile(path.join(home, "original"), "utf8")).toBe("original");
});

it("redacts control-obfuscated credentials before storage", async () => {
  const file = await prepareTranscript("check.json", home);
  await file.write({ prompt: "pass\u001b[0mword=fake-value" });
  await file.close();
  expect(await readFile(path.join(home, "check.json"), "utf8")).not.toContain("fake-value");
});
