import { expect, it, vi } from "vitest";
import { defaultCommand } from "./hermes-installer.js";

it("redacts bridge-shaped installer environment and argument credentials before diagnostics", async () => {
  vi.stubEnv("LOG_LEVEL", "debug");
  const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const environmentKey = "a1".repeat(32);
  const argumentKey = "b2".repeat(32);
  try {
    const result = await defaultCommand(
      process.execPath,
      [
        "-e",
        'process.stderr.write(process.env.BRIDGE_KEY + "\\n" + process.argv.at(-1) + "\\n"); process.stdout.write("1.2.3");',
        "--",
        "--token",
        argumentKey,
      ],
      { cwd: process.cwd(), env: { BRIDGE_KEY: environmentKey }, timeoutMs: 2000 },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("1.2.3");
    expect(result.stderr).toBe("[redacted]\n[redacted]");
    const logs = write.mock.calls.map(([line]) => String(line)).join("");
    expect(logs).toContain("hermes-installer stderr: [redacted]");
    expect(logs + result.stderr).not.toContain(environmentKey);
    expect(logs + result.stderr).not.toContain(argumentKey);
  } finally {
    write.mockRestore();
    vi.unstubAllEnvs();
  }
});
