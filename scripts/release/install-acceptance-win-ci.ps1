# Run real acceptance with a restricted non-admin token, even when runner UAC is disabled.
param([Parameter(Mandatory = $true, Position = 0)][string]$Artifact)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or $env:CI -ne 'true') { throw 'FAIL Disposable Windows CI runner required' }
$installer = (Resolve-Path -LiteralPath $Artifact).Path
$acceptance = Join-Path $PSScriptRoot 'install-acceptance-win.ps1'
$logs = $env:ARDUR_INSTALL_LOG_DIR
if (-not $logs) { throw 'FAIL Explicit acceptance log directory required' }
New-Item -ItemType Directory -Path $logs -Force | Out-Null
$logs = (Resolve-Path -LiteralPath $logs).Path
$work = Join-Path ([IO.Path]::GetTempPath()) ('ardur-token-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
$bootstrap = Join-Path $work 'accept.ps1'
$code = 1
function Quote-Literal([string]$Value) { return "'" + $Value.Replace("'", "''") + "'" }
# Only explicit test configuration is written; never serialize the runner environment.
@"
`$ErrorActionPreference = 'Stop'
`$env:ARDUR_INSTALL_LOG_DIR = $(Quote-Literal $logs)
try {
    & $(Quote-Literal (Join-Path $PSHOME 'pwsh.exe')) -NoProfile -NonInteractive -File $(Quote-Literal $acceptance) $(Quote-Literal $installer) *> $(Quote-Literal (Join-Path $logs 'launcher.log'))
    exit `$LASTEXITCODE
} catch {
    `$_ | Out-String | Add-Content -LiteralPath $(Quote-Literal (Join-Path $logs 'launcher.log'))
    exit 1
}
"@ | Set-Content -LiteralPath $bootstrap
try {
    Add-Type -Path (Join-Path $PSScriptRoot 'RestrictedProcess.cs')
    $code = [RestrictedProcess]::Run((Join-Path $PSHOME 'pwsh.exe'), "-NoProfile -NonInteractive -File `"$bootstrap`"", (Get-Location).Path, 600000)
    if ($code -ne 0) { throw "FAIL Unprivileged acceptance process exited nonzero ($code)" }
} finally {
    $launcherLog = Join-Path $logs 'launcher.log'
    if (Test-Path -LiteralPath $launcherLog) { Get-Content -LiteralPath $launcherLog | Write-Host }
    Remove-Item -LiteralPath $work -Recurse -Force
}
exit $code
