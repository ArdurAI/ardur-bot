import { afterEach, expect, it, vi } from "vitest";
import { ACL_SCRIPT, windowsAcl } from "./windows-acl.js";

afterEach(() => vi.unstubAllEnvs());
it("does not run a host command on POSIX", async () => {
  const run = vi.fn();
  await windowsAcl("config", true, "darwin", run);
  expect(run).not.toHaveBeenCalled();
});
it("passes even shell-looking paths only as data and protects inherited access", async () => {
  vi.stubEnv("SystemRoot", "C:\\Windows");
  const run = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
  const target = "C:\\Users\\fixture\\quoted'; write-host nope";
  await windowsAcl(target, true, "win32", run);
  expect(run).toHaveBeenCalledWith(
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", ACL_SCRIPT],
    expect.objectContaining({
      env: expect.objectContaining({ ARDUR_CONFIG_PATH: target, ARDUR_CONFIG_PROTECT: "1" }),
      timeout: 10_000,
    }),
  );
  expect(ACL_SCRIPT).toContain("SetAccessRuleProtection($true, $false)");
  expect(ACL_SCRIPT).not.toContain(target);
});
it("fails closed and never exposes command diagnostics", async () => {
  vi.stubEnv("SystemRoot", "C:\\Windows");
  const run = vi.fn().mockRejectedValue(new Error("private diagnostic"));
  await expect(windowsAcl("config", false, "win32", run)).rejects.toMatchObject({
    exitCode: 2,
    message: "Protect the Ardur config folder and file so only you can read them.",
  });
});
