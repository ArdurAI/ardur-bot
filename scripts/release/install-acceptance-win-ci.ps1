# Run the real acceptance script in the interactive user's filtered (non-admin) token.
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
$work = Join-Path ([IO.Path]::GetTempPath()) ('ardur-task-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
$bootstrap = Join-Path $work 'accept.ps1'
$result = Join-Path $work 'exit.txt'
$taskName = 'ArdurInstallAcceptance-' + [Guid]::NewGuid().ToString('N')
$registered = $false
$started = $false
$code = 1
function Quote-Literal([string]$Value) { return "'" + $Value.Replace("'", "''") + "'" }
# Only explicit test configuration is passed; never serialize the runner environment.
@"
`$ErrorActionPreference = 'Stop'
`$env:ARDUR_INSTALL_LOG_DIR = $(Quote-Literal $logs)
try {
    & $(Quote-Literal (Join-Path $PSHOME 'pwsh.exe')) -NoProfile -NonInteractive -File $(Quote-Literal $acceptance) $(Quote-Literal $installer) *> $(Quote-Literal (Join-Path $logs 'task.log'))
    `$code = `$LASTEXITCODE
} catch {
    `$_ | Out-String | Add-Content -LiteralPath $(Quote-Literal (Join-Path $logs 'task.log'))
    `$code = 1
}
`$code | Set-Content -LiteralPath $(Quote-Literal $result)
exit `$code
"@ | Set-Content -LiteralPath $bootstrap
try {
    # Interactive logon uses the existing desktop session, with no password or new account.
    # Limited explicitly removes the elevated token that PostgreSQL refuses.
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    $action = New-ScheduledTaskAction -Execute (Join-Path $PSHOME 'pwsh.exe') -Argument "-NoProfile -NonInteractive -File `"$bootstrap`"" -WorkingDirectory (Get-Location).Path
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
    Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings | Out-Null
    $registered = $true
    Start-ScheduledTask -TaskName $taskName
    $started = $true
    $deadline = (Get-Date).AddMinutes(10)
    do {
        Start-Sleep -Seconds 1
        $state = (Get-ScheduledTask -TaskName $taskName).State
        if ((Test-Path -LiteralPath $result) -and $state -ne 'Running') { break }
        if ((Get-Date) -ge $deadline) { throw 'FAIL Unprivileged acceptance task timed out or never started' }
    } while ($true)
    $code = [int](Get-Content -LiteralPath $result -Raw).Trim()
    $taskResult = (Get-ScheduledTaskInfo -TaskName $taskName).LastTaskResult
    if ($taskResult -ne 0 -or $code -ne 0) { throw "FAIL Unprivileged acceptance task exited nonzero ($code; task result $taskResult)" }
} finally {
    if ($registered) {
        # Only the uniquely named task created above may be stopped or removed.
        if ($started -and (Get-ScheduledTask -TaskName $taskName).State -eq 'Running') { Stop-ScheduledTask -TaskName $taskName }
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    }
    $taskLog = Join-Path $logs 'task.log'
    if (Test-Path -LiteralPath $taskLog) { Get-Content -LiteralPath $taskLog | Write-Host }
    Remove-Item -LiteralPath $work -Recurse -Force
}
exit $code
