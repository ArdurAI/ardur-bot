import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  new URL("../../../.github/workflows/release-desktop.yml", import.meta.url),
  "utf8",
);
const publish = readFileSync(
  new URL("../../../scripts/release-publish.mjs", import.meta.url),
  "utf8",
);
const desktop = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const root = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
describe("unsigned desktop release contract", () => {
  it("keeps credentials out of builds and limits publication to a complete pre-release", () => {
    expect(workflow).not.toMatch(/pull_request:|DESKTOP_.*CSC|APPLE_API|forceCodeSigning=true/);
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("needs: [validate, build]");
    expect(workflow).toContain("node scripts/release-publish.mjs");
    expect(publish).toContain('"--draft"');
    expect(publish).toContain('"--prerelease"');
    expect(publish).toContain('"--latest=false"');
    expect(workflow).toContain("origin/dev");
    expect(workflow).toContain('CSC_IDENTITY_AUTO_DISCOVERY: "false"');
    expect(workflow).toContain('tags: ["v*"]');
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toContain("origin/main");
  });
  it("pins third-party actions and includes every platform without certificates", () => {
    for (const match of workflow.matchAll(/uses:\s+([^\s#]+)/g))
      if (!match[1]?.startsWith("./")) expect(match[1]).toMatch(/@[0-9a-f]{40}$/);
    expect(workflow).toContain("platform: win, arch: x64");
    for (const platform of ["mac", "linux"])
      for (const arch of ["x64", "arm64"])
        expect(workflow).toContain(`platform: ${platform}, arch: ${arch}`);
  });
  it("uses root version, unsigned targets and the official update feed", () => {
    expect(desktop.version).toBe(root.version);
    expect(desktop.scripts.build).toContain("desktop-version.mjs");
    expect(desktop.build.mac).toMatchObject({
      identity: null,
      notarize: false,
      target: ["dmg", "zip"],
    });
    expect(desktop.build.linux).toMatchObject({
      executableName: "ardur-bot",
      target: ["AppImage", "deb"],
    });
    expect(desktop.build.win.target).toEqual(["nsis"]);
    expect(desktop.build.forceCodeSigning).toBe(false);
    expect(desktop.build.publish).toEqual([
      { provider: "github", owner: "ArdurAI", repo: "ardur-bot", releaseType: "prerelease" },
    ]);
  });
});
