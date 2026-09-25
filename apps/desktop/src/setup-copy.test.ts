import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SANDBOX_COMMAND_TIMEOUT_MS } from "../../../packages/core/src/sandbox-command.ts";

const repo = path.resolve(import.meta.dirname, "../../..");
const mac =
  "On this Mac, approvals, folder allowlists and secret redaction are enforced. Disk and CPU caps are advisory; a command stops after five minutes.";
const computer = mac.replace("On this Mac", "On this computer");

function collapsed(file: string) {
  return readFileSync(path.join(repo, file), "utf8").replace(/\s+/g, " ");
}

describe("local mode posture copy", () => {
  it("says folder allowlists are enforced and the command stops after the real default", () => {
    expect(DEFAULT_SANDBOX_COMMAND_TIMEOUT_MS).toBe(5 * 60_000);
    expect(collapsed("apps/desktop/src/setup.js")).toContain(mac);
    expect(collapsed("apps/desktop/src/setup.html")).toContain(computer);
    expect(collapsed("apps/desktop/src/setup.js")).toContain("Preparing the database.");
    expect(collapsed("README.md")).toContain(computer);
    expect(collapsed("docs/self-host.md")).toContain(computer);
    expect(collapsed("docs/desktop-release.md")).toContain(computer);
  });
});
