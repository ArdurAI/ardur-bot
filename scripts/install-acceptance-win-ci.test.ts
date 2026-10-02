import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const launcher = await readFile(
  new URL("./release/install-acceptance-win-ci.ps1", import.meta.url),
  "utf8",
);
const require = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const builder = createRequire(require.resolve("electron-builder"));
const workflow = builder("js-yaml").load(
  await readFile(new URL("../.github/workflows/release-desktop.yml", import.meta.url), "utf8"),
);

describe("Windows standard-user install acceptance", () => {
  it("generates and masks a temporary password without persisting credentials", () => {
    expect(launcher).toContain("[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)");
    expect(launcher).toContain('Write-Host "::add-mask::$password"');
    expect(launcher.indexOf("::add-mask::")).toBeLessThan(
      launcher.indexOf("ConvertTo-SecureString $password"),
    );
    expect(launcher).toContain("New-LocalUser -Name $name -Password $securePassword");
    expect(launcher).toContain("$state = @{ name = $name; sid = ''; work = $work }");
    const bootstrap = launcher.split('@"')[1].split('"@')[0];
    expect(bootstrap).not.toMatch(/password|credential/i);
    expect(launcher).not.toContain("RestrictedProcess");
  });

  it("loads the standard-user profile and checks the child's real exit status", async () => {
    expect(launcher).toContain("Get-LocalGroupMember -SID 'S-1-5-32-544'");
    expect(launcher).toContain("-Credential $credential -LoadUserProfile -Wait -PassThru");
    expect(launcher).toContain("$code = $process.ExitCode");
    expect(launcher).toContain("if ($code -ne 0)");
    expect(launcher).toContain("$acl.AddAccessRule($rule)");
    expect(launcher).toContain("ProfileList\\`$sid");
    expect(launcher).toContain("`$env:USERPROFILE = `$profile");
    const acceptance = await readFile(
      new URL("./release/install-acceptance-win.ps1", import.meta.url),
      "utf8",
    );
    expect(acceptance).toContain(
      "IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
    );
    expect(acceptance).toContain("$process.WaitForExit(180000)");
    expect(acceptance).toContain("ARDUR_INSTALL_SMOKE_PASS");
  });

  it("always removes the exact temporary account and profile before receipt creation", () => {
    const steps = workflow.jobs["install-acceptance"].steps;
    const cleanupIndex = steps.findIndex(
      (step: { name: string }) =>
        step.name === "Remove temporary Windows acceptance user and profile",
    );
    expect(cleanupIndex).toBeGreaterThan(0);
    expect(steps[cleanupIndex].if).toBe("always() && matrix.platform == 'win'");
    expect(steps[cleanupIndex].run).toContain("-Cleanup");
    expect(cleanupIndex).toBeLessThan(
      steps.findIndex((step: { name: string }) => step.name === "Record accepted installer hashes"),
    );
    expect(launcher).toContain("Remove-LocalUser -SID $user.SID");
    expect(launcher).toContain(
      "Get-CimInstance Win32_UserProfile -Filter \"SID='$($state.sid)'\" | Remove-CimInstance",
    );
  });
});
