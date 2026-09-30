import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const mac = new URL("./release/install-acceptance-mac.sh", import.meta.url);

describe("macOS install verdict", () => {
  it.each([
    [false, 3, "Ardur.app: rejected\nsource=no usable signature\n", true],
    [true, 0, "Ardur.app: accepted\nsource=Notarized Developer ID\n", true],
    [false, 3, "Ardur.app: rejected\nsource=no resources\n", false],
    [false, 3, "Ardur.app: rejected\nsource=no usable signature\ndamaged\n", false],
    [true, 3, "Ardur.app: rejected\nsource=no usable signature\n", false],
    [true, 0, "Ardur.app: accepted\nsource=Developer ID\n", false],
    [false, 0, "Ardur.app: rejected\nsource=no usable signature\n", false],
    [false, 3, "assessment unavailable\n", false],
  ])("signed=%s, status=%s, output=%s", async (signed, status, output, accepted) => {
    const script = await readFile(mac, "utf8");
    const predicate = script.match(/verdict\(\) \{[\s\S]*?\n\}/)?.[0];
    expect(predicate).toBeTruthy();
    const dir = await mkdtemp(path.join(os.tmpdir(), "install-verdict-"));
    try {
      await writeFile(path.join(dir, "spctl.log"), output);
      const result = spawnSync("bash", ["-c", `${predicate}\nverdict`], {
        encoding: "utf8",
        env: { ...process.env, logs: dir, signed: String(signed), spctl_status: String(status) },
      });
      expect(result.status === 0).toBe(accepted);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the cask launcher in the staged directory and executes the bundle path", async () => {
    const template = await readFile(new URL("../homebrew/Casks/ardur.rb", import.meta.url), "utf8");
    const preflight = template.match(/ {2}preflight do\n([\s\S]*?)\n {2}end/)?.[1];
    expect(preflight).toBeTruthy();
    const dir = await mkdtemp(path.join(os.tmpdir(), "cask-launcher-"));
    try {
      const result = spawnSync(
        "ruby",
        [
          "-e",
          `require 'pathname'; def appdir; ENV.fetch('APPDIR'); end; def staged_path; Pathname.new(ENV.fetch('STAGE')); end; ${preflight}`,
        ],
        { env: { ...process.env, APPDIR: `${dir}/Applications with spaces`, STAGE: dir } },
      );
      expect(result.status).toBe(0);
      const launcher = await readFile(path.join(dir, "ardur"), "utf8");
      expect(launcher).toContain('/Ardur.app/Contents/MacOS/Ardur "$@"');
      expect(launcher).toContain("Applications\\ with\\ spaces");
      expect(spawnSync("bash", ["-n", path.join(dir, "ardur")]).status).toBe(0);
      expect(template).toContain('binary "ardur"');
      expect(template).not.toContain('binary "#{appdir}');
      const bundleDirectory = path.join(dir, "Applications with spaces/Ardur.app/Contents/MacOS");
      await mkdir(bundleDirectory, { recursive: true });
      await writeFile(path.join(bundleDirectory, "Ardur"), '#!/bin/sh\nprintf "%s\\n" "$@"\n', {
        mode: 0o755,
      });
      await symlink(path.join(dir, "ardur"), path.join(dir, "command"));
      const opened = spawnSync(path.join(dir, "command"), ["argument with spaces", "--flag"], {
        encoding: "utf8",
      });
      expect(opened.status).toBe(0);
      expect(opened.stdout).toBe("argument with spaces\n--flag\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("macOS install launch verdict", () => {
  it.each([
    [0, "ARDUR_INSTALL_SMOKE_PASS\n", "", true],
    [0, "", "", false],
    [1, "ARDUR_INSTALL_SMOKE_PASS\n", "", false],
    [0, "ARDUR_INSTALL_SMOKE_PASS\n", "FATAL: renderer crashed\n", false],
    [0, "ARDUR_INSTALL_SMOKE_PASS\n", "Unable to find helper app\n", false],
    [0, "ARDUR_INSTALL_SMOKE_PASS\nFATAL\n", "", false],
  ])("checks status %s and both output streams", async (status, stdout, stderr, accepted) => {
    const script = await readFile(mac, "utf8");
    const smoke = script.match(/smoke\(\) \{[\s\S]*?\n\}/)?.[0];
    expect(smoke).toBeTruthy();
    const dir = await mkdtemp(path.join(os.tmpdir(), "mac-install-launch-"));
    try {
      const executable = path.join(dir, "fixture-app");
      await writeFile(
        executable,
        '#!/bin/sh\nprintf "%s" "$FIXTURE_STDOUT"\nprintf "%s" "$FIXTURE_STDERR" >&2\nexit "$FIXTURE_STATUS"\n',
        { mode: 0o755 },
      );
      const result = spawnSync("bash", ["-c", `${smoke}\nsmoke fixture "$executable"`], {
        env: {
          ...process.env,
          logs: dir,
          work: dir,
          executable,
          FIXTURE_STATUS: String(status),
          FIXTURE_STDOUT: stdout,
          FIXTURE_STDERR: stderr,
        },
      });
      expect(result.status === 0).toBe(accepted);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Linux install launch verdict", () => {
  it.each([
    [0, "ARDUR_INSTALL_SMOKE_PASS\n", "", true],
    [0, "", "", false],
    [1, "ARDUR_INSTALL_SMOKE_PASS\n", "", false],
    [0, "ARDUR_INSTALL_SMOKE_PASS\n", "FATAL: renderer crashed\n", false],
    [0, "ARDUR_INSTALL_SMOKE_PASS\n", "Unable to find helper app\n", false],
    [0, "ARDUR_INSTALL_SMOKE_PASS\nFATAL\n", "", false],
  ])("checks status %s and both output streams", async (status, stdout, stderr, accepted) => {
    const script = await readFile(
      new URL("./release/install-acceptance-linux.sh", import.meta.url),
      "utf8",
    );
    const predicate = script.match(/if \[\[ "\$status" != 0 \]\][\s\S]*?\nfi/)?.[0];
    expect(predicate).toBeTruthy();
    const dir = await mkdtemp(path.join(os.tmpdir(), "linux-install-verdict-"));
    try {
      await writeFile(path.join(dir, "app.stdout.log"), stdout);
      await writeFile(path.join(dir, "app.stderr.log"), stderr);
      const result = spawnSync("bash", ["-c", predicate!.replaceAll("/evidence", "$logs")], {
        env: { ...process.env, logs: dir, status: String(status) },
      });
      expect(result.status === 0).toBe(accepted);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
