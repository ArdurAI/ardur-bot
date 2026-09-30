# pwsh -File scripts/release/install-acceptance-win.ps1 <NSIS-installer>
param([Parameter(Mandatory = $true, Position = 0)][string]$Artifact)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'FAIL Windows runner required' }
$installer = (Resolve-Path -LiteralPath $Artifact).Path
$work = Join-Path ([IO.Path]::GetTempPath()) ('ardur-install-' + [Guid]::NewGuid().ToString('N'))
$logs = if ($env:ARDUR_INSTALL_LOG_DIR) { $env:ARDUR_INSTALL_LOG_DIR } else { Join-Path $work 'logs' }
$installDir = Join-Path $work 'Applications with spaces'
New-Item -ItemType Directory -Path $work, $logs -Force | Out-Null
$logs = (Resolve-Path -LiteralPath $logs).Path
$failed = $false
$installed = $false

function Summary([string]$Message) {
    $Message | Tee-Object -FilePath (Join-Path $logs 'summary.log') -Append | Write-Host
}

function Invoke-OwnedProcess([string]$File, [string]$Arguments, [string]$Label, [bool]$Smoke = $false) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $File
    $info.Arguments = $Arguments
    $info.UseShellExecute = $false
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    if ($Smoke) {
        foreach ($key in @('ELECTRON_RUN_AS_NODE', 'ARDURBOT_WEB_URL', 'ARDURBOT_LOCAL_WEB_URL')) {
            $info.Environment.Remove($key) | Out-Null
        }
        $info.Environment['ARDUR_INSTALL_SMOKE'] = '1'
        $info.Environment['ARDURBOT_DISABLE_AUTO_UPDATE'] = '1'
        $info.Environment['ARDURBOT_GUIDED_SETUP'] = '0'
        $info.Environment['ARDURBOT_USER_DATA_DIR'] = Join-Path $work 'profile'
        $info.Environment['ARDUR_INSTALL_SMOKE_SCREENSHOT'] = Join-Path $logs 'window.png'
    }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    $started = $false
    $stdout = $null
    $stderr = $null
    try {
        $started = $process.Start()
        if (-not $started) { throw "$Label did not start" }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(180000)) { throw "$Label timed out or showed a blocking dialog" }
        $process.WaitForExit()
        $out = $stdout.GetAwaiter().GetResult()
        $err = $stderr.GetAwaiter().GetResult()
        $out | Set-Content -LiteralPath (Join-Path $logs "$Label.stdout.log")
        $err | Set-Content -LiteralPath (Join-Path $logs "$Label.stderr.log")
        if ($process.ExitCode -ne 0) { throw "$Label exited nonzero ($($process.ExitCode))" }
        if ($Smoke -and ($out -notmatch '(?m)^ARDUR_INSTALL_SMOKE_PASS\r?$' -or
            ($out + $err) -match '(?i)FATAL|Unable to|damaged|crashed|Uncaught Exception')) {
            throw 'Installed app failed health/window/crash assertions'
        }
    } finally {
        # Only the process handle started above and its descendants may be stopped.
        if ($started -and -not $process.HasExited) {
            $process.Kill($true)
            $process.WaitForExit()
        }
        if ($null -ne $stdout) { $stdout.GetAwaiter().GetResult() | Set-Content -LiteralPath (Join-Path $logs "$Label.stdout.log") }
        if ($null -ne $stderr) { $stderr.GetAwaiter().GetResult() | Set-Content -LiteralPath (Join-Path $logs "$Label.stderr.log") }
        $process.Dispose()
    }
}

try {
    # The NSIS installer/uninstaller can stop an existing app itself. Refuse before invoking it.
    if (Get-Process -Name Ardur -ErrorAction SilentlyContinue) { throw 'An existing Ardur process is running; use a clean machine' }
    $keys = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')
    foreach ($key in $keys) {
        $existing = Get-ItemProperty $key -ErrorAction SilentlyContinue |
            Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -eq 'Ardur' }
        if ($existing) { throw 'An existing Ardur installation is registered; use a clean machine' }
    }
    # The pinned builder parses everything following /D= as the directory, including spaces.
    $installed = $true
    Invoke-OwnedProcess $installer "/S /D=$installDir" 'install'
    $exe = Join-Path $installDir 'Ardur.exe'
    if (-not (Test-Path -LiteralPath $exe)) { throw 'Silent installer did not create Ardur.exe in the requested directory' }
    Summary 'PASS NSIS silent installation into temporary directory'
    $startedAt = Get-Date
    Invoke-OwnedProcess $exe '' 'app' $true
    $events = Get-WinEvent -FilterHashtable @{ LogName = 'Application'; Id = @(1000, 1001); StartTime = $startedAt } -ErrorAction SilentlyContinue
    if ($events | Where-Object { $_.Message -like "*$exe*" }) { throw 'Installed app produced a Windows crash event' }
    Summary 'PASS installed app opens, health answers, clean exit, no crash event'
} catch {
    Summary ('FAIL ' + $_.Exception.Message)
    $failed = $true
} finally {
    if ($installed) {
        try {
            $uninstallers = @(Get-ChildItem -LiteralPath $installDir -Filter '*Uninstall*.exe' -ErrorAction SilentlyContinue)
            if ($uninstallers.Count -ne 1) { throw 'Generated NSIS uninstaller missing or ambiguous' }
            $uninstaller = Join-Path $work 'Uninstall.exe'
            Copy-Item -LiteralPath $uninstallers[0].FullName -Destination $uninstaller
            # _?= avoids NSIS handing off to an untracked temporary uninstaller; keep it last.
            Invoke-OwnedProcess $uninstaller "/S /KEEP_APP_DATA _?=$installDir" 'uninstall'
            if (Test-Path -LiteralPath (Join-Path $installDir 'Ardur.exe')) { throw 'Ardur.exe remained after uninstall' }
            Summary 'PASS NSIS silent uninstall'
        } catch {
            Summary ('FAIL cleanup: ' + $_.Exception.Message)
            $failed = $true
        }
    }
    # Leave diagnostics, remove only files created by this run. No real profile is touched.
    foreach ($item in @($installDir, (Join-Path $work 'profile'), (Join-Path $work 'Uninstall.exe'))) {
        if (Test-Path -LiteralPath $item) { Remove-Item -LiteralPath $item -Recurse -Force }
    }
    Write-Host "Logs: $logs"
}
if ($failed) { exit 1 }
exit 0
