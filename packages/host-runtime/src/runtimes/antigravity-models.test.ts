import { spawn } from "node:child_process";
import { expect, it, vi } from "vitest";
import * as hostEnvironment from "../host-environment.js";
import {
  antigravityModels,
  capturedAntigravityModels,
  parseAntigravityModels,
} from "./antigravity-models.js";

it("redacts a bridge-shaped credential handed to the model probe's environment", async () => {
  vi.stubEnv("LOG_LEVEL", "debug");
  vi.stubEnv("ARDUR_DETAILED_PROCESS_LOGS", "1");
  const secret = "a1".repeat(32);
  const env = vi
    .spyOn(hostEnvironment, "nativeEnvironment")
    .mockReturnValue({ BRIDGE_KEY: secret });
  const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    await antigravityModels("fixture-probe", "fixture-version", () =>
      spawn(
        process.execPath,
        ["-e", 'process.stderr.write(process.env.BRIDGE_KEY + "\\n"); process.exit(4);'],
        { env: { BRIDGE_KEY: secret }, stdio: "pipe" },
      ),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const logs = write.mock.calls.map(([line]) => String(line)).join("");
    expect(logs).toContain("antigravity-models stderr: [redacted]");
    expect(logs).not.toContain(secret);
    const errors = write.mock.calls
      .map(([line]) => JSON.parse(String(line)))
      .filter((record) => record.level === "error");
    expect(JSON.stringify(errors)).not.toContain("stderr tail");
  } finally {
    write.mockRestore();
    env.mockRestore();
    vi.unstubAllEnvs();
  }
});

it("keeps the dated catalog and exact suffix rules", () => {
  expect(capturedAntigravityModels).toHaveLength(14);
  expect(
    capturedAntigravityModels.find((model) => model.id === "claude-sonnet-4-6")?.efforts,
  ).toEqual([]);
  expect(
    capturedAntigravityModels.find((model) => model.id === "gpt-oss-120b-medium")?.efforts,
  ).toEqual(["medium"]);
});
it.each(["bad", "id\tlabel\nid\tlabel", "id\tbad\u0000label", "\tlabel"])(
  "rejects malformed catalog %j",
  (output) => {
    expect(() => parseAntigravityModels(output)).toThrow();
  },
);
