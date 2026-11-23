[CmdletBinding()]
param(
    [ValidateSet('unit', 'browser', 'firefox', 'all')]
    [string]$Suite = 'all',
    [string]$Node = 'node',
    [switch]$DisableSandbox,
    [switch]$ShowBrowser
)

$ErrorActionPreference = 'Stop'
# Node.jsテストはUTF-8で出力するため、PowerShell側の受信エンコーディングを合わせる。
# 実行後は呼び出し元の設定へ復元する。
$originalOutputEncoding = $OutputEncoding
$originalConsoleEncoding = [Console]::OutputEncoding
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$root = Split-Path -Parent $PSScriptRoot

$scripts = @{
    unit = Join-Path $PSScriptRoot 'novel_viewer_unit_test.js'
    browser = Join-Path $PSScriptRoot 'novel_viewer_browser_test.js'
    firefox = Join-Path $PSScriptRoot 'novel_viewer_firefox_test.js'
}
$results = [System.Collections.Generic.List[object]]::new()

function Write-TestLine([string]$Line) {
    $color = $null
    if ($Line -match '\[\s*FAILED') { $color = 'Red' }
    elseif ($Line -match '\[\s*(PASSED|OK)') { $color = 'Green' }
    elseif ($Line -match '\[\s*RUN') { $color = 'Green' }
    elseif ($Line -match '\[\s*(----------|==========)') { $color = 'Green' }
    if ($null -eq $color) { Write-Host $Line } else { Write-Host $Line -ForegroundColor $color }
}

function Invoke-TestScript([string]$Name) {
    $script = $scripts[$Name]
    if (-not (Test-Path -LiteralPath $script -PathType Leaf)) {
        throw "テストスクリプトが見つかりません: $script"
    }
    Write-Host "`n=== $Name TEST ===" -ForegroundColor Green
    try {
        $savedErrorAction = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $captured = [System.Collections.Generic.List[string]]::new()
        $childOutput = @(& $Node $script 2>&1)
        $nativeExitCode = $LASTEXITCODE
        $ErrorActionPreference = $savedErrorAction
        foreach ($entry in $childOutput) {
            $_ = $entry
            $line = [string]$_
            $captured.Add($line)
            Write-TestLine $line
        }
        $output = $captured -join "`n"
        $code = if ($null -eq $nativeExitCode) { 0 } else { [int]$nativeExitCode }
        if ($childOutput.Count -eq 0 -and $code -lt 0) { $code = 1 }
    } catch {
        if ($null -ne $savedErrorAction) { $ErrorActionPreference = $savedErrorAction }
        $code = 1
        Write-Error "[ FAILED ] $Name TEST (PowerShell実行例外)`n  $($_.Exception.Message)"
    }
    $results.Add([pscustomobject]@{ Name = $Name; Code = $code })
    if ($code -ne 0) {
        Write-Error "[ FAILED ] $Name TEST (exit code: $code)"
        return $false
    }
    $summary = [regex]::Match($output, '\[  PASSED  \] (\d+) tests\.')
    if ($summary.Success) {
        $totalMatch = [regex]::Match($output, '\[==========\] (\d+) tests ran\.')
        $total = if ($totalMatch.Success) { $totalMatch.Groups[1].Value } else { '?' }
        Write-Host ("[  RESULT  ] {0,-8}: {1}/{2}" -f $Name, $summary.Groups[1].Value, $total) -ForegroundColor Green
    } elseif ($output -match '未実施|CDPポートへ接続できません') {
        Write-Host ("[  RESULT  ] {0,-8}: 未実施 (CDP接続不可、終了コード: {1})" -f $Name, $code) -ForegroundColor Yellow
    } else {
        Write-Host ("[  RESULT  ] {0,-8}: unknown" -f $Name) -ForegroundColor Yellow
    }
    return $true
}

try {
    Push-Location $root
    $savedSandbox = $env:NOVEL_VIEWER_DISABLE_SANDBOX
    if ($DisableSandbox) { $env:NOVEL_VIEWER_DISABLE_SANDBOX = '1' } else { Remove-Item Env:NOVEL_VIEWER_DISABLE_SANDBOX -ErrorAction SilentlyContinue }
    $savedShowBrowser = $env:NOVEL_VIEWER_SHOW_BROWSER
    if ($ShowBrowser) { $env:NOVEL_VIEWER_SHOW_BROWSER = '1' } else { Remove-Item Env:NOVEL_VIEWER_SHOW_BROWSER -ErrorAction SilentlyContinue }
    $success = $true
    if ($Suite -eq 'all') {
        $success = (Invoke-TestScript 'unit') -and $success
        $success = (Invoke-TestScript 'browser') -and $success
    } else {
        $success = Invoke-TestScript $Suite
    }
    $passed = @($results | Where-Object Code -eq 0).Count
    $total = $results.Count
    if ($success) {
        Write-Host "`n[  PASSED  ] $passed test units." -ForegroundColor Green
        exit 0
    }
    Write-Error "[  FAILED  ] $($total - $passed) test units."
    exit 1
} catch {
    Write-Error $_
    exit 1
} finally {
    if ($null -eq $savedSandbox) { Remove-Item Env:NOVEL_VIEWER_DISABLE_SANDBOX -ErrorAction SilentlyContinue } else { $env:NOVEL_VIEWER_DISABLE_SANDBOX = $savedSandbox }
    if ($null -eq $savedShowBrowser) { Remove-Item Env:NOVEL_VIEWER_SHOW_BROWSER -ErrorAction SilentlyContinue } else { $env:NOVEL_VIEWER_SHOW_BROWSER = $savedShowBrowser }
    if ($null -eq $originalOutputEncoding) {
        Remove-Variable -Name OutputEncoding -Scope Local -ErrorAction SilentlyContinue
    } else {
        $OutputEncoding = $originalOutputEncoding
    }
    [Console]::OutputEncoding = $originalConsoleEncoding
    Pop-Location
}
