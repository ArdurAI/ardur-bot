import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import signedConfig from "../apps/desktop/scripts/signed-mac-config.mjs";
import { parseSigned, releaseNotes } from "./desktop-release.mjs";

const desktop = fileURLToPath(new URL("../apps/desktop", import.meta.url));
const desktopRequire = createRequire(path.join(desktop, "package.json"));
const builderRequire = createRequire(desktopRequire.resolve("electron-builder"));
const yaml = builderRequire("js-yaml");
const release = yaml.load(
  await readFile(new URL("../.github/workflows/release-desktop.yml", import.meta.url), "utf8"),
);
const performance = yaml.load(
  await readFile(new URL("../.github/workflows/performance.yml", import.meta.url), "utf8"),
);
const credentials = [
  "MAC_CERTIFICATE_P12",
  "MAC_CERTIFICATE_PASSWORD",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
];

describe("optional macOS release signing", () => {
  it("selects signing only when every credential is present, without exposing values", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "signing-decision-"));
    try {
      const step = release.jobs.validate.steps.find(
        (entry: { id?: string }) => entry.id === "signing",
      );
      expect(Object.keys(step.env).sort()).toEqual([...credentials].sort());
      for (const missing of [null, ...credentials, "all"]) {
        const output = path.join(root, `decision-${missing}.txt`);
        const env = Object.fromEntries(
          credentials.map((key) => [
            key,
            missing === key || missing === "all" ? "" : "fixture-value",
          ]),
        );
        const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", step.run], {
          encoding: "utf8",
          env: { PATH: process.env.PATH, HOME: root, GITHUB_OUTPUT: output, ...env },
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe("");
        expect(await readFile(output, "utf8")).toBe(`signed=${missing === null}\n`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads a fail-closed hardened/notarized configuration using the real builder loader", async () => {
    const { getConfig, validateConfiguration } = builderRequire(
      "app-builder-lib/out/util/config/config.js",
    );
    const config = await getConfig(desktop, "scripts/signed-mac-config.mjs", null);
    await validateConfiguration(config, { isEnabled: false });
    expect(config.mac.identity).toBeUndefined();
    expect(config.mac.type).toBe("distribution");
    expect(config.mac.hardenedRuntime).toBe(true);
    expect(config.mac.notarize).toBe(true);
    expect(config.mac.strictVerify).toBe(true);
    expect(config.forceCodeSigning).toBe(true);
    expect(config.afterSign).toBe("./scripts/sign-mac-preview.mjs");
    expect(config.extraResources).toContainEqual(
      expect.objectContaining({ to: "host-service/host-service.cjs" }),
    );
    expect(signedConfig.mac.entitlementsInherit).toBe(signedConfig.mac.entitlements);
    const plist = await readFile(path.join(desktop, signedConfig.mac.entitlements), "utf8");
    for (const entitlement of [
      "allow-jit",
      "allow-unsigned-executable-memory",
      "disable-library-validation",
    ])
      expect(plist).toContain(`<key>com.apple.security.cs.${entitlement}</key>`);
  });

  it("confines credentials and temporary keychain operations to the signed macOS steps", () => {
    const steps = release.jobs.build.steps;
    const signing = steps.find(
      (step: { name?: string }) => step.name === "Import Developer ID into a temporary keychain",
    );
    const pack = steps.find(
      (step: { name?: string }) => step.name === "Package with Developer ID and notarize",
    );
    const cleanup = steps.find(
      (step: { name?: string }) => step.name === "Delete the temporary signing keychain",
    );
    const condition = "matrix.platform == 'mac' && needs.validate.outputs.signed == 'true'";
    expect(signing.if).toBe(condition);
    expect(pack.if).toBe(condition);
    expect(cleanup.if).toBe(`always() && ${condition}`);
    expect(cleanup.run).toContain('security delete-keychain "$CSC_KEYCHAIN"');
    expect(pack.env.CSC_IDENTITY_AUTO_DISCOVERY).toBe("true");
    expect(release.jobs.build.env.CSC_IDENTITY_AUTO_DISCOVERY).toBe("false");
    expect(release.jobs.build.name).toContain("'Signed' || 'Unsigned'");
    expect(release.jobs.evidence.with.mac_signed).toContain("needs.validate.outputs.signed");
    expect(performance.on.workflow_call.inputs.mac_signed.type).toBe("boolean");
    expect(JSON.stringify(performance.jobs["release-gate"].steps)).toContain("signing.json");
    expect(JSON.stringify(release.jobs.publish.steps)).toContain("--signing-record");
    for (const step of steps) {
      if (Object.keys(step.env ?? {}).some((key) => credentials.includes(key)))
        expect(step.if).toBe(condition);
      expect(step.run ?? "").not.toMatch(/set -[a-z]*x|echo.*\$(?:MAC_CERTIFICATE|APPLE_)/);
    }
  });

  it("parses signing flags strictly and describes only macOS as signed", async () => {
    expect(parseSigned()).toBe(false);
    expect(parseSigned("false")).toBe(false);
    expect(parseSigned("true")).toBe(true);
    for (const value of ["", "yes", "TRUE", "1"]) expect(() => parseSigned(value)).toThrow();
    const notes = await releaseNotes([], undefined, true);
    expect(notes).toContain("Signed and notarized for macOS.");
    expect(notes).not.toContain("Unsigned preview");
    expect(notes).toContain(
      "macOS updates require downloading and installing the new build manually.",
    );
  });
});
