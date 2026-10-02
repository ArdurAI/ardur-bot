# Run acceptance as a disposable standard user, independent of runner UAC settings.
param([Parameter(Position = 0)][string]$Artifact, [switch]$Cleanup)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or $env:CI -ne 'true') { throw 'FAIL Disposable Windows CI runner required' }
$stateFile = Join-Path $env:RUNNER_TEMP 'ardur-install-user.json'
if ($Cleanup) {
    if (-not (Test-Path -LiteralPath $stateFile)) { exit 0 }
    $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
    $user = Get-LocalUser -Name $state.name -ErrorAction SilentlyContinue
    if ($user) {
        if ($state.sid -and $user.SID.Value -ne $state.sid) { throw 'FAIL Cleanup user SID mismatch' }
        Remove-LocalUser -SID $user.SID
    }
    if ($state.sid) {
        Get-CimInstance Win32_UserProfile -Filter "SID='$($state.sid)'" | Remove-CimInstance
    }
    if (Test-Path -LiteralPath $state.work) { Remove-Item -LiteralPath $state.work -Recurse -Force }
    Remove-Item -LiteralPath $stateFile -Force
    Write-Host 'PASS temporary standard user and profile cleanup'
    exit 0
}
if (-not $Artifact) { throw 'FAIL Installer required' }
if (Test-Path -LiteralPath $stateFile) { throw 'FAIL Previous acceptance user state exists' }
$installer = (Resolve-Path -LiteralPath $Artifact).Path
$acceptance = Join-Path $PSScriptRoot 'install-acceptance-win.ps1'
$logs = $env:ARDUR_INSTALL_LOG_DIR
if (-not $logs) { throw 'FAIL Explicit acceptance log directory required' }
New-Item -ItemType Directory -Path $logs -Force | Out-Null
$logs = (Resolve-Path -LiteralPath $logs).Path
$work = Join-Path $env:RUNNER_TEMP ('ardur-user-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
$name = 'ardur' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
$state = @{ name = $name; sid = ''; work = $work }
$state | ConvertTo-Json | Set-Content -LiteralPath $stateFile
$bytes = [byte[]]::new(48)
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$password = 'Aa1!' + [Convert]::ToBase64String($bytes)
Write-Host "::add-mask::$password"
$securePassword = ConvertTo-SecureString $password -AsPlainText -Force
$password = $null
[Array]::Clear($bytes, 0, $bytes.Length)
$user = New-LocalUser -Name $name -Password $securePassword -AccountNeverExpires -UserMayNotChangePassword
$state.sid = $user.SID.Value
$state | ConvertTo-Json | Set-Content -LiteralPath $stateFile
Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $user
if (Get-LocalGroupMember -SID 'S-1-5-32-544' | Where-Object { $_.SID -eq $user.SID }) {
    throw 'FAIL Acceptance user must not belong to Administrators'
}
foreach ($directory in @($work, $logs)) {
    $acl = Get-Acl -LiteralPath $directory
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($user.SID, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)

    Set-Acl -LiteralPath $directory -AclObject $acl
}
# Stage only the installer and script; the child does not need access to the checkout.
$stagedInstaller = Join-Path $work 'installer.exe'
$stagedAcceptance = Join-Path $work 'install-acceptance-win.ps1'
Copy-Item -LiteralPath $installer -Destination $stagedInstaller
Copy-Item -LiteralPath $acceptance -Destination $stagedAcceptance
$bootstrap = Join-Path $work 'accept.ps1'
$code = 1
function Quote-Literal([string]$Value) { return "'" + $Value.Replace("'", "''") + "'" }
# Only explicit test configuration is written; never serialize the runner environment.
@"
`$ErrorActionPreference = 'Stop'
`$env:ARDUR_INSTALL_LOG_DIR = $(Quote-Literal $logs)
`$env:TEMP = $(Quote-Literal $work)
`$env:TMP = $(Quote-Literal $work)
try {
    # Start-Process may inherit the runner's environment even with a loaded user profile.
    `$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    `$profile = (Get-ItemProperty -LiteralPath "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\`$sid").ProfileImagePath
    `$env:USERPROFILE = `$profile
    `$env:APPDATA = Join-Path `$profile 'AppData\Roaming'
    `$env:LOCALAPPDATA = Join-Path `$profile 'AppData\Local'
    `$env:HOMEDRIVE = [IO.Path]::GetPathRoot(`$profile).TrimEnd('\')
    `$env:HOMEPATH = `$profile.Substring(`$env:HOMEDRIVE.Length)
    & $(Quote-Literal $stagedAcceptance) $(Quote-Literal $stagedInstaller)
    exit `$LASTEXITCODE
} catch {
    [Console]::Error.WriteLine(`$_.Exception.Message)
    exit 1
}
"@ | Set-Content -LiteralPath $bootstrap
try {
    $credential = [PSCredential]::new(".\$name", $securePassword)
    $process = Start-Process -FilePath (Join-Path $PSHOME 'pwsh.exe') -ArgumentList "-NoProfile -NonInteractive -File `"$bootstrap`"" -WorkingDirectory $work -Credential $credential -LoadUserProfile -Wait -PassThru -RedirectStandardOutput (Join-Path $logs 'launcher.stdout.log') -RedirectStandardError (Join-Path $logs 'launcher.stderr.log')
    $code = $process.ExitCode
    $process.Dispose()
    if ($code -ne 0) { throw "FAIL Unprivileged acceptance process exited nonzero ($code)" }
} finally {
    $securePassword.Dispose()
    foreach ($file in @('launcher.stdout.log', 'launcher.stderr.log')) {
        $launcherLog = Join-Path $logs $file
        if (Test-Path -LiteralPath $launcherLog) { Get-Content -LiteralPath $launcherLog | Write-Host }
    }
    # The workflow's always() step removes the account/profile even after launch failure.
}
exit $code
