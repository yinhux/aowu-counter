<#
  嗷呜计数 — core.jsx 单元测试运行脚本

  优先使用本机 DSH 内置 Node，找不到时回退 PATH 中的 node。
  用法（在项目根目录或任意目录均可）：
      powershell -NoProfile -ExecutionPolicy Bypass -File tests\run-tests.ps1
#>
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$testFiles = @(
    (Join-Path $scriptDir "core.test.js"),
    (Join-Path $scriptDir "dom-detector.test.js")
)
$bundledNode = "C:\Users\YINHU\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

if (Test-Path -LiteralPath $bundledNode) {
    $node = $bundledNode
    Write-Host ("使用内置 Node: " + $node) -ForegroundColor Cyan
} else {
    $command = Get-Command node -ErrorAction SilentlyContinue
    if (-not $command) {
        Write-Host "找不到 Node：内置路径不存在，PATH 中也没有 node。" -ForegroundColor Red
        exit 2
    }
    $node = $command.Source
    Write-Host ("使用 PATH 中的 Node: " + $node) -ForegroundColor Yellow
}

foreach ($testFile in $testFiles) {
    if (-not (Test-Path -LiteralPath $testFile)) {
        Write-Host ("测试文件不存在: " + $testFile) -ForegroundColor Red
        exit 2
    }
}

Write-Host ("运行: " + $node + " --test " + ($testFiles -join ' ')) -ForegroundColor Cyan
Write-Host ""

& $node --test @testFiles
exit $LASTEXITCODE
