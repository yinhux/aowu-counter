[CmdletBinding()]
param(
    [string]$Version = '1.4.1'
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

$staging = Join-Path ([System.IO.Path]::GetTempPath()) ('aowu-counter-build-' + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging -Force | Out-Null

try {
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
        if (-not (Test-Path -LiteralPath $src)) {
            throw ('缺少发布文件：' + $item)
        }
        Copy-Item -LiteralPath $src -Destination (Join-Path $staging $item) -Recurse -Force
        Write-Host ('  + ' + $item) -ForegroundColor Green
    }

    # README 引用的截图（只发布 docs/preview-*.png，其余 docs 不发布）
    $previewDstDir = Join-Path $staging 'docs'
    $previewNames = @('preview-main.png', 'preview-minimized.png', 'preview-about.png')
    foreach ($name in $previewNames) {
        $src = Join-Path $projectRoot ('docs\' + $name)
        if (Test-Path -LiteralPath $src) {
            if (-not (Test-Path -LiteralPath $previewDstDir)) {
                New-Item -ItemType Directory -Path $previewDstDir -Force | Out-Null
            }
            Copy-Item -LiteralPath $src -Destination (Join-Path $previewDstDir $name) -Force
            Write-Host ('  + docs\' + $name + '（README 截图）') -ForegroundColor Green
        }
    }

    # 发布必备文件校验
    $required = @(
        'CSXS\manifest.xml',
        'js\app.js',
        'js\bridge.js',
        'js\csinterface.js',
        'jsx\host.jsx',
        'jsx\core.jsx',
        'jsx\dom-detector.jsx',
        'jsx\window-drag.ps1',
        'jsx\hotkey.ps1',
        'css\style.css',
        'icons\icon.png',
        'index.html',
        'install.ps1',
        'uninstall.ps1',
        '安装.bat',
        '卸载.bat',
        'README.md'
    )
    foreach ($rel in $required) {
        $full = Join-Path $staging $rel
        if (-not (Test-Path -LiteralPath $full)) {
            throw ('打包校验失败，缺少：' + $rel)
        }
    }

    # 版本一致性提示
    $manifestText = [System.IO.File]::ReadAllText((Join-Path $staging 'CSXS\manifest.xml'), [System.Text.Encoding]::UTF8)
    if ($manifestText -notmatch [regex]::Escape('ExtensionBundleVersion="' + $Version + '"')) {
        Write-Warning ('manifest.xml 的 ExtensionBundleVersion 与打包版本 ' + $Version + ' 不一致，请检查。')
    }

    if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
    Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zipPath -CompressionLevel Optimal -Force

    $size = [math]::Round((Get-Item -LiteralPath $zipPath).Length / 1024, 1)
    Write-Host ''
    Write-Host ('打包完成：' + $zipPath + '  (' + $size + ' KB)') -ForegroundColor Cyan
}
finally {
    if (Test-Path -LiteralPath $staging) {
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    }
}
