import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CONTAINER_FILE_SCRIPT } from "./container-files.js";

function run(
  root: string,
  operation: string,
  relative: string,
  extra: string[] = [],
  input?: Buffer,
) {
  return spawnSync("python3", ["-c", CONTAINER_FILE_SCRIPT, operation, root, relative, ...extra], {
    input,
  });
}

describe("container file confinement", () => {
  it("does not follow a symlink while reading, listing, or writing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "container-files-"));
    const outside = await mkdtemp(path.join(tmpdir(), "container-files-outside-"));
    const secret = path.join(outside, "secret.md");
    try {
      await writeFile(secret, "top-secret-bytes");
      await writeFile(path.join(root, "plain.md"), "hello");
      await symlink(secret, path.join(root, "notes.md"));
      await symlink(path.join(root, "plain.md"), path.join(root, "alias.md"));
      await mkdir(path.join(root, "bots", "other"), { recursive: true });
      await mkdir(path.join(root, "bots", "bot"), { recursive: true });
      await writeFile(path.join(root, "bots", "other", "secret.md"), "top-secret-bytes");
      await symlink(
        path.join("..", "other", "secret.md"),
        path.join(root, "bots", "bot", "notes.md"),
      );
      await symlink(outside, path.join(root, "linked"));

      const escaped = run(root, "write", "notes.md", ["false"], Buffer.from("pwned"));
      expect(escaped.status).not.toBe(0);
      expect(escaped.stderr.toString()).toBe("file not available\n");
      expect(escaped.stderr.toString()).not.toContain("top-secret-bytes");
      expect(await readFile(secret, "utf8")).toBe("top-secret-bytes");
      expect((await lstat(path.join(root, "notes.md"))).isSymbolicLink()).toBe(true);

      const alias = run(root, "write", "alias.md", ["false"], Buffer.from("pwned"));
      expect(alias.status).not.toBe(0);
      expect(await readFile(path.join(root, "plain.md"), "utf8")).toBe("hello");

      const crossed = run(root, "write", "bots/bot/notes.md", ["false"], Buffer.from("pwned"));
      expect(crossed.status).not.toBe(0);
      expect(await readFile(path.join(root, "bots", "other", "secret.md"), "utf8")).toBe(
        "top-secret-bytes",
      );

      const throughDirectory = run(
        root,
        "write",
        "linked/secret.md",
        ["false"],
        Buffer.from("pwned"),
      );
      expect(throughDirectory.status).not.toBe(0);
      expect(await readFile(secret, "utf8")).toBe("top-secret-bytes");
      expect((await lstat(path.join(root, "linked"))).isSymbolicLink()).toBe(true);

      const listed = run(root, "list", "");
      expect(listed.status).toBe(0);
      const names = JSON.parse(listed.stdout.toString()).map(
        (entry: { path: string }) => entry.path,
      );
      expect(names).toContain("plain.md");
      expect(names).not.toContain("notes.md");
      expect(names).not.toContain("alias.md");
      expect(names).not.toContain("linked");

      const listedLink = run(root, "list", "linked");
      expect(listedLink.status).not.toBe(0);
      expect(listedLink.stdout.toString()).not.toContain("top-secret-bytes");

      const readLink = run(root, "read", "notes.md", ["-1", "read"]);
      expect(readLink.status).not.toBe(0);
      expect(readLink.stdout.toString()).not.toContain(
        Buffer.from("top-secret-bytes").toString("base64"),
      );
      expect(readLink.stderr.toString()).not.toContain(secret);

      const readPlain = run(root, "read", "plain.md", ["-1", "read"]);
      expect(readPlain.status).toBe(0);
      expect(Buffer.from(readPlain.stdout.toString(), "base64").toString()).toBe("hello");

      const saved = run(root, "write", "plain.md", ["false"], Buffer.from("hello!"));
      expect(saved.status).toBe(0);
      expect(await readFile(path.join(root, "plain.md"), "utf8")).toBe("hello!");
      expect((await lstat(path.join(root, "plain.md"))).mode & 0o777).toBe(0o600);

      const nested = run(root, "write", "nested/leaf.md", ["true"], Buffer.from("leaf"));
      expect(nested.status).toBe(0);
      expect(await readFile(path.join(root, "nested", "leaf.md"), "utf8")).toBe("leaf");
      expect((await lstat(path.join(root, "nested", "leaf.md"))).mode & 0o777).toBe(0o700);

      await writeFile(path.join(root, "wide.md"), "0123456789");
      const preview = run(root, "read", "wide.md", ["4", "preview"]);
      expect(preview.status).toBe(0);
      expect(Buffer.from(preview.stdout.toString(), "base64")).toEqual(Buffer.from("0123"));
      const limited = run(root, "read", "wide.md", ["4", "read"]);
      expect(limited.status).toBe(42);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
