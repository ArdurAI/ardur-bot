# Offline process-boundary tests; no Electron, installer or database is started.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'install-acceptance-win.ps1'
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$functions = $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-OwnedProcess' }, $true)
if ($functions.Count -ne 1) { throw 'Process boundary missing' }
. ([ScriptBlock]::Create($functions[0].Extent.Text))
$work = Join-Path ([IO.Path]::GetTempPath()) ('ardur-process-test-' + [Guid]::NewGuid().ToString('N'))
$logs = Join-Path $work 'logs'
New-Item -ItemType Directory -Path $logs -Force | Out-Null
$cases = @(
    @{ Code = "[Console]::WriteLine('ARDUR_INSTALL_SMOKE_PASS'); exit 0"; Pass = $true },
    @{ Code = "[Console]::WriteLine('ARDUR_INSTALL_SMOKE_PASS'); exit 1"; Pass = $false },
    @{ Code = "[Console]::WriteLine('not ready'); exit 0"; Pass = $false },
    @{ Code = "[Console]::WriteLine('ARDUR_INSTALL_SMOKE_PASS'); [Console]::Error.WriteLine('FATAL'); exit 0"; Pass = $false },
    @{ Code = "[Console]::WriteLine('ARDUR_INSTALL_SMOKE_PASS'); [Console]::WriteLine('Unable to find helper app'); exit 0"; Pass = $false }
)
try {
    $index = 0
    foreach ($case in $cases) {
        $accepted = $true
        try {
            Invoke-OwnedProcess (Join-Path $PSHOME 'pwsh.exe') "-NoProfile -NonInteractive -Command `"$($case.Code)`"" "fixture-$index" $true
        } catch { $accepted = $false }
        if ($accepted -ne $case.Pass) { throw "Wrong verdict for fixture $index" }
        $index++
    }
    Write-Host "PASS Windows process boundary: $index offline cases and script parsing"
} finally {
    Remove-Item -LiteralPath $work -Recurse -Force
}
