<#
  嗷呜计数 (Aowu Counter) v1.0.0 — Windows 卸载脚本

  功能：
    1. 删除当前用户的 CEP 扩展目录：
       %APPDATA%\Adobe\CEP\extensions\com.aowu.counter
    2. 提示计数数据文件位置（默认保留数据，加 -RemoveData 才删除）。
    3. 检测 Photoshop 是否在运行并提示重新启动。

  说明：
    - 不删除注册表中的 PlayerDebugMode（避免影响其他 CEP 插件）。
    - 计数数据固定保存在 %APPDATA%\AowuCounter\aowu-counter-data.txt；
      默认卸载保留，重装插件后记录仍在。
    - 可选参数：
        -DestinationRoot <dir>   从指定目录根卸载（默认 %APPDATA%\Adobe\CEP\extensions）
        -RemoveData              同时删除计数数据目录（不可恢复，默认不删）
#>
[CmdletBinding()]
param(
    [string]$DestinationRoot = '',
    [switch]$RemoveData
)

$ErrorActionPreference = 'Stop'

$ExtensionId = 'com.aowu.counter'

function Write-Info([string]$text) { Write-Host $text -ForegroundColor Cyan }
function Write-Ok([string]$text) { Write-Host $text -ForegroundColor Green }
function Write-Warn([string]$text) { Write-Host $text -ForegroundColor Yellow }
function Write-Err([string]$text) { Write-Host $text -ForegroundColor Red }

Write-Info '=============================================='
Write-Info '  嗷呜计数 - 卸载程序'
Write-Info '=============================================='

if ([string]::IsNullOrWhiteSpace($DestinationRoot)) {
    $appData = $env:APPDATA
    if ([string]::IsNullOrWhiteSpace($appData)) {
        $appData = [Environment]::GetFolderPath('ApplicationData')
    }
    $DestinationRoot = Join-Path $appData 'Adobe\CEP\extensions'
}
$targetDir = Join-Path $DestinationRoot $ExtensionId
$dataDir = Join-Path $env:APPDATA 'AowuCounter'
$dataFile = Join-Path $dataDir 'aowu-counter-data.txt'

$photoshop = @(Get-Process -Name 'Photoshop' -ErrorAction SilentlyContinue)
if ($photoshop.Count -gt 0) {
    Write-Warn '检测到 Photoshop 正在运行：建议先完全退出 Photoshop 再卸载。'
}

if (-not (Test-Path -LiteralPath $targetDir)) {
    Write-Warn ('未找到安装目录，无需卸载：' + $targetDir)
} else {
    Write-Info ('正在删除扩展文件：' + $targetDir)
    try {
        Remove-Item -LiteralPath $targetDir -Recurse -Force
    } catch {
        Write-Err ('删除失败：' + $_.Exception.Message)
        Write-Err '请先完全退出 Photoshop 后重新运行卸载脚本。'
        exit 1
    }
    if (Test-Path -LiteralPath $targetDir) {
        Write-Err '卸载失败：扩展目录仍然存在。'
        exit 1
    }
    Write-Ok '已删除扩展文件。'
}

# --- 计数数据：默认保留 -------------------------------------------------
if ($RemoveData) {
    if (Test-Path -LiteralPath $dataDir) {
        Write-Warn ('按 -RemoveData 删除计数数据：' + $dataDir)
        try {
            Remove-Item -LiteralPath $dataDir -Recurse -Force
            Write-Ok '计数数据已删除。'
        } catch {
            Write-Err ('删除计数数据失败：' + $_.Exception.Message)
            exit 1
        }
    } else {
        Write-Warn ('没有找到计数数据目录：' + $dataDir)
    }
} else {
    if (Test-Path -LiteralPath $dataFile) {
        Write-Ok ''
        Write-Ok ('计数数据已保留：' + $dataFile)
        Write-Info '（重新安装插件后，计数记录会自动恢复。）'
        Write-Info '如需连数据一起删除，请运行：'
        Write-Info '  powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1 -RemoveData'
    } else {
        Write-Info ''
        Write-Info ('没有找到计数数据文件（可能从未计数）：' + $dataFile)
    }
}

Write-Ok ''
Write-Ok '已卸载 嗷呜计数。'
Write-Info ''
Write-Info '提示：'
Write-Info '  - 注册表中的 CEP 调试模式（PlayerDebugMode）保持原样，不影响其他插件。'
Write-Info '  - 完全退出并重新启动 Photoshop 2025 后卸载才会完全生效。'
exit 0
