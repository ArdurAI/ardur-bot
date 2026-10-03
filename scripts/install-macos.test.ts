import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const script = await readFile(new URL("./install.sh", import.meta.url), "utf8");
const branch = `${script.split('echo "Installing..."')[1]?.split('elif [[ "$EXT" == "deb" ]]')[0]}\nfi`;
const mocks = `
log() { printf '%s' "$1"; shift; printf ' <%s>' "$@"; printf '\\n'; }
mkdir() { log mkdir "$@"; }
rm() { log rm "$@"; }
cp() { log cp "$@"; }
hdiutil() { log hdiutil "$@"; }
xattr() { log xattr "$@"; return "$XATTR_STATUS"; }
`;

describe("macOS installer first open", () => {
  it.each([0, 1])(
    "removes quarantine after copying and reports failure honestly (exit=%s)",
    async (status) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "mac-install-"));
      try {
        const result = spawnSync(
          "/bin/bash",
          ["--noprofile", "--norc", "-c", `set -euo pipefail\n${mocks}\n${branch}`],
          {
            encoding: "utf8",
            env: {
              PATH: process.env.PATH,
              HOME: root,
              TMP_DIR: root,
              PLATFORM: "mac",
              ASSET_NAME: "fixture.dmg",
              XATTR_STATUS: String(status),
            },
          },
        );
        expect(result.stderr).toBe("");
        expect(result.status).toBe(status);
        const installed = result.stdout.match(/Installed to (.+)\.\n/)?.[1];
        expect(installed).toBeTruthy();
        expect(result.stdout).toContain(`xattr <-dr> <com.apple.quarantine> <${installed}>`);
        expect(result.stdout.indexOf("cp <-R>")).toBeLessThan(result.stdout.indexOf("xattr <-dr>"));
        expect(result.stdout.indexOf("hdiutil <detach>")).toBeLessThan(
          result.stdout.indexOf("xattr <-dr>"),
        );
        expect(result.stdout.includes("Removed the download quarantine flag from Ardur.app.")).toBe(
          status === 0,
        );
        expect(result.stdout).not.toContain("Unsigned preview");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("discloses quarantine removal during a network-free dry run", () => {
    expect(script).toContain('echo "Plan: Remove the download quarantine flag from Ardur.app"');
    expect(script.indexOf("Plan: Remove the download quarantine flag")).toBeLessThan(
      script.indexOf("TMP_DIR=$(mktemp -d)"),
    );
  });
});
