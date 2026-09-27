import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");

describe("winget manifests", () => {
  it("have valid offline schema fields", async () => {
    const installer = yaml.load(
      await readFile(new URL("./ArdurAI.ArdurBot.installer.yaml", import.meta.url), "utf8"),
    );
    const locale = yaml.load(
      await readFile(new URL("./ArdurAI.ArdurBot.locale.en-US.yaml", import.meta.url), "utf8"),
    );
    const version = yaml.load(
      await readFile(new URL("./ArdurAI.ArdurBot.yaml", import.meta.url), "utf8"),
    );

    expect(installer.PackageIdentifier).toBe("ArdurAI.ArdurBot");
    expect(installer.Installers[0].Architecture).toBe("x64");
    expect(installer.Installers[0].InstallerType).toBe("nullsoft");

    expect(locale.PackageIdentifier).toBe("ArdurAI.ArdurBot");
    expect(locale.Publisher).toBe("ArdurAI");
    expect(locale.PackageName).toBe("Ardur Bot");

    expect(version.PackageIdentifier).toBe("ArdurAI.ArdurBot");
    expect(version.DefaultLocale).toBe("en-US");
  });
});
