import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { CliError } from "./transport.js";

const execute = promisify(execFile);
// Paths are data in an environment variable, never interpolated into shell code.
// Remove inherited access before writing any key; loading also verifies the ACL.
export const ACL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$p = $env:ARDUR_CONFIG_PATH
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
if ($env:ARDUR_CONFIG_PROTECT -eq '1') {
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $p -AclObject $acl
}
$acl = Get-Acl -LiteralPath $p
if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'owner' }
foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -ne $sid.Value) { throw 'access' }
}
`;
export async function windowsAcl(
  target: string,
  protect = false,
  platform = process.platform,
  run = execute,
) {
  if (platform !== "win32") return;
  const root = process.env.SystemRoot;
  if (!root || !path.win32.isAbsolute(root))
    throw new CliError("Windows cannot protect the Ardur config folder.", 2);
  try {
    await run(
      path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", ACL_SCRIPT],
      {
        env: {
          ...process.env,
          ARDUR_CONFIG_PATH: target,
          ARDUR_CONFIG_PROTECT: protect ? "1" : "0",
        },
        timeout: 10_000,
        windowsHide: true,
        maxBuffer: 16_384,
      },
    );
  } catch {
    throw new CliError("Protect the Ardur config folder and file so only you can read them.", 2);
  }
}
