[CmdletBinding()]
param(
    [string]$Version = '1.1.3'
)

$ErrorActionPreference = 'Stop'

$toolsDir = $PSScriptRoot
$projectRoot = Split-Path -Parent $toolsDir
$outputRoot = Split-Path -Parent $projectRoot
$zipName = '嗷呜计数_v' + $Version + '.zip'
$zipPath = Join-Path $outputRoot $zipName

Write-Host '==============================================' -ForegroundColor Cyan
Write-Host ('  嗷呜计数 v' + $Version + ' - 打包') -ForegroundColor Cyan
Write-Host '==============================================' -ForegroundColor Cyan
Write-Host ('项目目录：' + $projectRoot)
Write-Host ('输出文件：' + $zipPath)

# --- 必要的发布文件 -------------------------------------------------
$required = @(
    'CSXS\manifest.xml',
    'index.html',
    'css\style.css',
    'js\csinterface.js',
    'js\bridge.js',
    'js\app.js',
    'jsx\host.jsx',
    'jsx\core.jsx',
    'jsx\dom-detector.jsx',
    'jsx\window-drag.ps1',
    'install.ps1',
    'uninstall.ps1',
    '安装.bat',
    '卸载.bat',
    'README.md'
)
$missing = @()
foreach ($rel in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot $rel))) { $missing += $rel }
}
if ($missing.Count -gt 0) {
    Write-Host '打包失败：缺少必要文件：' -ForegroundColor Red
    $missing | ForEach-Object { Write-Host ('  - ' + $_) -ForegroundColor Red }
    exit 1
}

$staging = Join-Path ([System.IO.Path]::GetTempPath()) ('aowu-counter-build-' + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging -Force | Out-Null

try {
    # 安装包内容：CSXS/js/jsx/css/icons/index.html + 安装/卸载脚本 + README
    # 明确不包含：tests/、tools/、docs/、_aowu-qa/
    $includeItems = @(
        'CSXS',
        'js',
        'jsx',
        'css',
        'icons',
        'index.html',
        'install.ps1',
        'uninstall.ps1',
        '安装.bat',
        '卸载.bat',
        'README.md'
    )
    foreach ($item in $includeItems) {
        $src = Join-Path $projectRoot $item
        if (Test-Path -LiteralPath $src) {
            Copy-Item -LiteralPath $src -Destination $staging -Recurse -Force
            Write-Host ('  + ' + $item) -ForegroundColor Green
        } else {
            Write-Host ('  ! 跳过（不存在）：' + $item) -ForegroundColor Yellow
        }
    }

    # README 引用 docs/preview-*.png；只把截图打进包，其余开发资料不发布
    $previewSrcs = @('docs\preview-main.png', 'docs\preview-minimized.png')
    $previewDstDir = Join-Path $staging 'docs'
    foreach ($previewRel in $previewSrcs) {
        $previewSrc = Join-Path $projectRoot $previewRel
        if (Test-Path -LiteralPath $previewSrc) {
            if (-not (Test-Path -LiteralPath $previewDstDir)) {
                New-Item -ItemType Directory -Path $previewDstDir -Force | Out-Null
            }
            Copy-Item -LiteralPath $previewSrc -Destination $previewDstDir -Force
            Write-Host ('  + ' + $previewRel + '（README 截图）') -ForegroundColor Green
        }
    }

    # 保险：清除可能混入的开发/测试产物
    $excludedNames = @(
        '_aowu-qa', 'tests', 'tools',
        '.DS_Store', 'Thumbs.db',
        'selftest.flag', 'selftest-result.json', 'selftest.log',
        'host-check.js', 'qa-shell.html'
    )
    foreach ($name in $excludedNames) {
        Get-ChildItem -LiteralPath $staging -Recurse -Force -Filter $name -ErrorAction SilentlyContinue |
            ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
    }
    Get-ChildItem -LiteralPath $staging -Recurse -Force -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Extension -in @('.log', '.tmp', '.map') } |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
    Get-ChildItem -LiteralPath $staging -Recurse -Force -Filter '*.zip' -ErrorAction SilentlyContinue |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force }

    # 打包前校验：包内必须包含清单与面板入口
    $stagedManifest = Join-Path $staging 'CSXS\manifest.xml'
    $stagedIndex = Join-Path $staging 'index.html'
    if (-not (Test-Path -LiteralPath $stagedManifest) -or -not (Test-Path -LiteralPath $stagedIndex)) {
        throw '打包内容不完整：缺少 CSXS/manifest.xml 或 index.html'
    }

    if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
    $items = @(Get-ChildItem -LiteralPath $staging -Force)
    if ($items.Count -eq 0) { throw '打包内容为空' }
    Compress-Archive -Path $items.FullName -DestinationPath $zipPath -CompressionLevel Optimal -Force

    $zipInfo = Get-Item -LiteralPath $zipPath
    Write-Host ''
    Write-Host ('打包完成：' + $zipPath + '  (' + [math]::Round($zipInfo.Length / 1KB, 1) + ' KB)') -ForegroundColor Green
    Write-Host ''
    Write-Host '安装包内容（根目录）：'
    $items | Sort-Object Name | ForEach-Object { Write-Host ('  ' + $_.Name) }
} finally {
    if (Test-Path -LiteralPath $staging) {
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    }
}
