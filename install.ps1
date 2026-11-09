<#
  嗷呜计数 (Aowu Counter) v1.4.3 — Windows 一键安装脚本

  功能：
    1. 把插件运行文件复制到当前用户的 CEP 扩展目录：
       %APPDATA%\Adobe\CEP\extensions\com.aowu.counter
    2. 为未签名的 CEP 扩展开启调试模式（仅当前用户）：
       HKCU\Software\Adobe\CSXS.8 ~ CSXS.13 写入 PlayerDebugMode=1
    3. 检测 Photoshop 是否在运行，并提示需要重启 Photoshop。

  说明：
    - 重复运行是安全的（覆盖更新，不报错）。
    - 从 zip 解压后直接双击 安装.bat 即可；脚本会自动定位同目录下的插件文件。
    - 只操作 CEP 扩展目录；**绝不删除计数数据**
      （数据固定保存在 %APPDATA%\AowuCounter\aowu-counter-data.txt，重装/升级不清除）。
    - 可选参数（主要供自动化测试使用）：
        -DestinationRoot <dir>   安装到指定目录根（默认 %APPDATA%\Adobe\CEP\extensions）
        -SkipRegistry            不写注册表（dry-run 用）
#>
[CmdletBinding()]
param(
    [string]$DestinationRoot = '',
    [switch]$SkipRegistry
)

$ErrorActionPreference = 'Stop'

$ExtensionId = 'com.aowu.counter'
$Version = '1.4.3'

function Write-Info([string]$text) { Write-Host $text -ForegroundColor Cyan }
function Write-Ok([string]$text) { Write-Host $text -ForegroundColor Green }
function Write-Warn([string]$text) { Write-Host $text -ForegroundColor Yellow }
function Write-Err([string]$text) { Write-Host $text -ForegroundColor Red }

Write-Info '=============================================='
Write-Info ('  嗷呜计数 v' + $Version + ' - 安装程序')
Write-Info '=============================================='

$sourceDir = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($sourceDir)) {
    $sourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
Write-Info ('源目录：' + $sourceDir)

# --- 1. 检查必要文件 -------------------------------------------------
$required = @(
    'CSXS\manifest.xml',
    'index.html',
    'css\style.css',
    'js\bridge.js',
    'js\csinterface.js',
    'js\app.js',
    'jsx\host.jsx',
    'jsx\core.jsx',
    'jsx\dom-detector.jsx',
    'jsx\window-drag.ps1',
    'jsx\hotkey.ps1'
)
$missing = @()
foreach ($rel in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $sourceDir $rel))) {
        $missing += $rel
    }
}
if ($missing.Count -gt 0) {
    Write-Err '安装失败：源目录缺少以下必要文件：'
    foreach ($item in $missing) {
        Write-Err ('  - ' + $item)
    }
    Write-Err '请确认已完整解压安装包（不要只解压出单个文件），然后在解压后的文件夹中运行 安装.bat。'
    exit 1
}

# --- 2. 确定安装目标目录 ---------------------------------------------
if ([string]::IsNullOrWhiteSpace($DestinationRoot)) {
    $appData = $env:APPDATA
    if ([string]::IsNullOrWhiteSpace($appData)) {
        $appData = [Environment]::GetFolderPath('ApplicationData')
    }
    $DestinationRoot = Join-Path $appData 'Adobe\CEP\extensions'
}
$targetDir = Join-Path $DestinationRoot $ExtensionId
Write-Info ('目标目录：' + $targetDir)

# --- 3. 复制运行文件（覆盖安装，幂等；只动扩展目录，不动用户数据） ----
$includeItems = @('CSXS', 'js', 'jsx', 'css', 'icons', 'index.html')
$sameDir = $false
try {
    if (Test-Path -LiteralPath $targetDir) {
        try {
            $srcFull = (Resolve-Path -LiteralPath $sourceDir).ProviderPath.TrimEnd('\')
            $tgtFull = (Resolve-Path -LiteralPath $targetDir).ProviderPath.TrimEnd('\')
            if ($srcFull -ieq $tgtFull) { $sameDir = $true }
        } catch {
            $sameDir = $false
        }
        if ($sameDir) {
            Write-Warn '检测到当前就在安装目录中运行，跳过文件复制，只检查注册表与运行文件。'
        } else {
            Write-Info '清理旧的扩展文件（不影响计数数据）…'
            Remove-Item -LiteralPath $targetDir -Recurse -Force
        }
    }
    if (-not (Test-Path -LiteralPath $targetDir)) {
        New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
    }
    if (-not $sameDir) {
        foreach ($item in $includeItems) {
            $sourceItem = Join-Path $sourceDir $item
            if (Test-Path -LiteralPath $sourceItem) {
                Copy-Item -LiteralPath $sourceItem -Destination $targetDir -Recurse -Force
                Write-Ok ('  已复制 ' + $item)
            } else {
                Write-Warn ('  跳过（源中不存在）：' + $item)
            }
        }
    }
} catch {
    Write-Err ('复制文件失败：' + $_.Exception.Message)
    Write-Err '如果 Photoshop 正在运行，请先完全退出 Photoshop 后再试。'
    exit 1
}

# --- 4. 开启未签名扩展调试模式 ---------------------------------------
$registryOk = 0
$registryFail = 0
if ($SkipRegistry) {
    Write-Warn '已跳过注册表设置（-SkipRegistry）。'
} else {
    Write-Info '正在为未签名 CEP 扩展开启调试模式（仅当前用户）…'
    $csxsVersions = @('8', '9', '10', '11', '12', '13')
    foreach ($ver in $csxsVersions) {
        $keyPath = 'HKCU:\Software\Adobe\CSXS.' + $ver
        try {
            if (-not (Test-Path -LiteralPath $keyPath)) {
                New-Item -Path $keyPath -Force | Out-Null
            }
            New-ItemProperty -Path $keyPath -Name 'PlayerDebugMode' -Value '1' -PropertyType String -Force | Out-Null
            Write-Ok ('  CSXS.' + $ver + '  PlayerDebugMode=1')
            $registryOk += 1
        } catch {
            Write-Warn ('  CSXS.' + $ver + ' 注册表写入失败：' + $_.Exception.Message)
            $registryFail += 1
        }
    }
}

# --- 5. 校验安装结果 -------------------------------------------------
$verifyFiles = @(
    'CSXS\manifest.xml',
    'index.html',
    'css\style.css',
    'js\bridge.js',
    'js\csinterface.js',
    'js\app.js',
    'jsx\host.jsx',
    'jsx\core.jsx',
    'jsx\dom-detector.jsx',
    'jsx\window-drag.ps1',
    'jsx\hotkey.ps1'
)
$verifyMissing = @()
foreach ($rel in $verifyFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $targetDir $rel))) {
        $verifyMissing += $rel
    }
}
if ($verifyMissing.Count -gt 0) {
    Write-Err '安装失败：目标目录中缺少以下文件：'
    foreach ($item in $verifyMissing) {
        Write-Err ('  - ' + $item)
    }
    exit 1
}
Write-Ok '运行文件校验通过。'

# --- 6. 检测 Photoshop 是否在运行 -------------------------------------
$photoshop = @(Get-Process -Name 'Photoshop' -ErrorAction SilentlyContinue)
if ($photoshop.Count -gt 0) {
    Write-Warn '检测到 Photoshop 正在运行：需要完全退出并重新启动 Photoshop，菜单里才会出现「嗷呜计数」。'
}

# --- 7. 完成信息（含数据位置，绝不删除） -------------------------------
$dataDir = Join-Path $env:APPDATA 'AowuCounter'
$dataFile = Join-Path $dataDir 'aowu-counter-data.txt'

Write-Ok ''
Write-Ok ('安装完成：' + $targetDir)
if ($registryFail -gt 0) {
    Write-Warn ('提示：有 ' + $registryFail + ' 个 CSXS 注册表项写入失败。若面板不显示，请重新运行安装脚本。')
}
if ($registryOk -eq 0 -and -not $SkipRegistry) {
    Write-Warn '提示：未能写入任何 CSXS 注册表项，未签名扩展可能无法加载。'
}
Write-Info ''
Write-Info ('计数数据固定保存在：' + $dataFile)
Write-Info '（重装/升级插件不会清除；卸载默认也保留，见卸载说明。）'
Write-Info ''
Write-Info '使用方法：'
Write-Info '  1. 完全退出并重新启动 Photoshop。'
Write-Info '  2. 打开任意文档，选择菜单：窗口 > 扩展（旧版）> 嗷呜计数。'
Write-Info '  3. 面板出现后保持打开，用画笔/铅笔在画布上画一笔即可看到计数 +1。'
Write-Info ''
Write-Info '如需卸载：运行 卸载.bat（或 uninstall.ps1）。'
exit 0
