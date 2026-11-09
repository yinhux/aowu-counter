# 嗷呜计数 v1.2.0 — 全局快捷键隐藏助手（由 host.jsx 经隐藏 VBS 启动）
# 用途：注册单键全局热键（无修饰键，A-Z / 0-9 / F1-F12），按下时把 Unix ms 时间戳覆盖写入 FireFile，
#       面板 host.jsx 轮询 FireFile 消费触发信号（全局切换「暂停计数」，即使焦点在 Photoshop 画布）。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File hotkey.ps1
#         -Key P -FireFile "...\aowu-counter-hotkey.fire" -StopFile "...\aowu-counter-hotkey.stop"
#         -StatusFile "...\aowu-counter-hotkey.status"
# 状态文件：state=registered|error / key= / vk= / pid= / ts= / error=（启动后覆盖写）
# 退出码：0=正常（StopFile 出现或 Photoshop 退出）；2=非法 key；3=热键注册失败；1=其他异常
# 注意：Windows 把 F12 保留给调试器，RegisterHotKey(F12) 恒返回 1409；此时本脚本如实写 error=register_failed
#       （不是脚本缺陷；面板若允许选 F12，需自行提示该键不可用）。
# 实现：RegisterHotKey 绑定当前线程消息队列，不创建任何窗口；PeekMessage 手动泵消息，每 40ms 一轮。
#       host 用 wscript WScript.Shell.Run(..., 0, False) 隐藏启动，脚本自身不主动开窗、不写控制台输出。
# -NoPhotoshopCheck：仅独立测试用，跳过 Photoshop 进程检查；生产 host 不传（PS 不在则立即退出，避免孤儿进程）。
# 防御：若 host 在换键重启时删除了 StatusFile，助手也主动退出，避免旧进程继续占着旧热键。
param(
    [string]$Key = '',
    [string]$FireFile = '',
    [string]$StopFile = '',
    [string]$StatusFile = '',
    [switch]$NoPhotoshopCheck
)

$ErrorActionPreference = 'Stop'

$script:statusPath = $StatusFile
$script:firePath = $FireFile
$script:stopPath = $StopFile
$script:keyShown = ''
$script:vk = 0
$script:registered = $false
$script:hotkeyId = 1

# 状态文件是 key=value 行格式，值里不能出现换行/制表符（避免打断 host.jsx 的逐行解析）。
function ConvertTo-StatusSafe([string]$text) {
    if ($null -eq $text) { return '' }
    $s = [string]$text
    $s = $s -replace "[\r\n\t]", ' '
    if ($s.Length -gt 200) { $s = $s.Substring(0, 200) }
    return $s
}

function Write-Status([string]$state, [string]$errorText) {
    if ([string]::IsNullOrEmpty($script:statusPath)) { return }
    try {
        $dir = [System.IO.Path]::GetDirectoryName($script:statusPath)
        if (-not [string]::IsNullOrEmpty($dir) -and -not [System.IO.Directory]::Exists($dir)) {
            [void][System.IO.Directory]::CreateDirectory($dir)
        }
        $lines = @(
            ('state=' + $state),
            ('key=' + (ConvertTo-StatusSafe $script:keyShown)),
            ('vk=' + [string]$script:vk),
            ('pid=' + [string]$PID),
            ('ts=' + ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()).ToString()),
            ('error=' + (ConvertTo-StatusSafe $errorText))
        )
        $text = ($lines -join "`n") + "`n"
        [System.IO.File]::WriteAllText($script:statusPath, $text, (New-Object System.Text.UTF8Encoding($false)))
    } catch { }
}

# fire 文件用「写临时文件 + 原子替换」更新，避免 host 轮询到空/半截内容。
function Write-Fire {
    if ([string]::IsNullOrEmpty($script:firePath)) { return }
    try {
        $dir = [System.IO.Path]::GetDirectoryName($script:firePath)
        if (-not [string]::IsNullOrEmpty($dir) -and -not [System.IO.Directory]::Exists($dir)) {
            [void][System.IO.Directory]::CreateDirectory($dir)
        }
        $ms = ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()).ToString()
        $tmpPath = $script:firePath + '.tmp'
        [System.IO.File]::WriteAllText($tmpPath, $ms, (New-Object System.Text.UTF8Encoding($false)))
        if ([System.IO.File]::Exists($script:firePath)) {
            try {
                [System.IO.File]::Replace($tmpPath, $script:firePath, $null)
            } catch {
                [System.IO.File]::Copy($tmpPath, $script:firePath, $true)
                try { [System.IO.File]::Delete($tmpPath) } catch { }
            }
        } else {
            try {
                [System.IO.File]::Move($tmpPath, $script:firePath)
            } catch {
                [System.IO.File]::Copy($tmpPath, $script:firePath, $true)
                try { [System.IO.File]::Delete($tmpPath) } catch { }
            }
        }
    } catch { }
}

# 单键 A-Z / 0-9 / F1-F12（大小写不敏感）→ 虚拟键码；非法返回 0。
function Get-VirtualKey([string]$rawKey) {
    if ($null -eq $rawKey) { return 0 }
    $k = ([string]$rawKey).Trim().ToUpperInvariant()
    if ($k -match '^[A-Z0-9]$') { return [int][char]$k }
    if ($k -match '^F([1-9]|1[0-2])$') { return (0x70 + ([int]$Matches[1] - 1)) }
    return 0
}

$rawKey = ''
if ($null -ne $Key) { $rawKey = [string]$Key }
$rawTrim = $rawKey.Trim()
$script:keyShown = $rawTrim.ToUpperInvariant()
if ($script:keyShown.Length -gt 32) { $script:keyShown = $script:keyShown.Substring(0, 32) }
$script:vk = Get-VirtualKey $rawTrim
$watchPs = $false
$psProcId = 0

try {
    if ($script:vk -le 0) {
        Write-Status 'error' 'invalid_key'
        exit 2
    }
    if ([string]::IsNullOrEmpty($script:statusPath) -or [string]::IsNullOrEmpty($script:firePath)) {
        exit 1
    }

    # 生产路径（host 不传 -NoPhotoshopCheck）：Photoshop 不在就退出，避免留下孤儿进程。
    if (-not $NoPhotoshopCheck) {
        $psProc = Get-Process -Name 'Photoshop' -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $psProc) {
            Write-Status 'error' 'photoshop_not_running'
            exit 0
        }
        $psProcId = [int]$psProc.Id
        $watchPs = $true
    }

    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class AowuHotkeyNative
{
    [StructLayout(LayoutKind.Sequential)]
    public struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public int ptX;
        public int ptY;
    }

    public const int WM_HOTKEY = 0x0312;
    private const uint PM_REMOVE = 0x0001;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    [DllImport("user32.dll")]
    private static extern bool PeekMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax, uint wRemoveMsg);

    public static int Register(int id, uint vk)
    {
        if (RegisterHotKey(IntPtr.Zero, id, 0, vk)) { return 0; }
        return Marshal.GetLastWin32Error();
    }

    public static bool Unregister(int id)
    {
        return UnregisterHotKey(IntPtr.Zero, id);
    }

    public static int Pump()
    {
        int fired = 0;
        MSG msg;
        while (PeekMessage(out msg, IntPtr.Zero, 0, 0, PM_REMOVE))
        {
            if (msg.message == WM_HOTKEY) { fired++; }
        }
        return fired;
    }
}
"@

    $regError = [AowuHotkeyNative]::Register($script:hotkeyId, [uint32]$script:vk)
    if ($regError -ne 0) {
        Write-Status 'error' 'register_failed'
        exit 3
    }
    $script:registered = $true
    Write-Status 'registered' ''

    $lastPsCheck = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    while ($true) {
        $fired = [AowuHotkeyNative]::Pump()
        if ($fired -gt 0) { Write-Fire }

        if (-not [string]::IsNullOrEmpty($script:stopPath) -and [System.IO.File]::Exists($script:stopPath)) { break }

        # host 换键重启时会先删旧 StatusFile；状态文件被删也退出，防止旧助手占着旧热键。
        if ([System.IO.File]::Exists($script:statusPath) -eq $false) { break }

        $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        if ($watchPs -and (($now - $lastPsCheck) -ge 1000)) {
            $lastPsCheck = $now
            if (-not (Get-Process -Id $psProcId -ErrorAction SilentlyContinue)) { break }
        }

        Start-Sleep -Milliseconds 40
    }
} catch {
    $msg = 'internal_error'
    try { $msg = 'internal_error: ' + [string]$_.Exception.Message } catch { }
    Write-Status 'error' $msg
    exit 1
} finally {
    if ($script:registered) {
        try { [AowuHotkeyNative]::Unregister($script:hotkeyId) | Out-Null } catch { }
    }
}
exit 0
