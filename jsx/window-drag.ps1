# 嗷呜计数 v1.1.1 — 面板窗口移动助手（由 host.jsx 通过隐藏 bat 启动）
# 用途：最小化横条拖拽时，按 %TEMP%\aowu-counter-drag.ctrl 的坐标移动 Photoshop 面板窗口；
#       把当前窗口 rect 写到 %TEMP%\aowu-counter-drag.status，供面板 JS 读取。
# 说明：CEP 没有移动窗口的 JS API，所以用一个常驻 PowerShell 助手（窗口隐藏）轮询控制文件。
$ErrorActionPreference = 'SilentlyContinue'

$ctrlPath = Join-Path $env:TEMP 'aowu-counter-drag.ctrl'
$statusPath = Join-Path $env:TEMP 'aowu-counter-drag.status'

# 单实例：避免重复拖拽时启动多个助手
$mutex = New-Object System.Threading.Mutex($false, 'Local\AowuCounterWindowDrag')
if (-not $mutex.WaitOne(0)) { exit 0 }

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class AowuDrag {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);
  [DllImport("user32.dll")] public static extern int SetWindowRgn(IntPtr hWnd, IntPtr hRgn, bool redraw);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr hObject);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

function Write-Status([IntPtr]$hwnd, [int]$contentW, [int]$contentH) {
  $text = "found=0`n"
  if ($hwnd -ne [IntPtr]::Zero) {
    $r = New-Object AowuDrag+RECT
    if ([AowuDrag]::GetWindowRect($hwnd, [ref]$r)) {
      $w = $r.Right - $r.Left
      $h = $r.Bottom - $r.Top
      $text = "found=1`nx=" + $r.Left + "`ny=" + $r.Top + "`nw=" + $w + "`nh=" + $h + "`ncontentW=" + $contentW + "`ncontentH=" + $contentH + "`nts=" + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + "`n"
    }
  }
  try { [System.IO.File]::WriteAllText($statusPath, $text, (New-Object System.Text.UTF8Encoding($false))) } catch { }
}

$psProc = Get-Process Photoshop -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $psProc) {
  Write-Status ([IntPtr]::Zero) 0 0
  exit 0
}
$psPid = [uint32]$psProc.Id
$script:target = [IntPtr]::Zero
$script:contentW = 0
$script:contentH = 0
$script:expectedW = 0
$script:expectedH = 0
$script:clipOn = $false
$script:origDock = $null
$script:origContentRel = $null
$script:lastClipAt = 0

function Find-PanelDock {
  if ($script:expectedW -le 0 -or $script:expectedH -le 0) { $script:target = [IntPtr]::Zero; return $false }
  $script:target = [IntPtr]::Zero
  $script:candidates = New-Object System.Collections.ArrayList
  $script:psId = $psPid
  [AowuDrag]::EnumWindows({
    param($hWnd, $lParam)
    if ($script:target -ne [IntPtr]::Zero) { return $true }
    $winPid = [uint32]0
    [AowuDrag]::GetWindowThreadProcessId($hWnd, [ref]$winPid) | Out-Null
    if ($winPid -ne $script:psId) { return $true }
    if (-not [AowuDrag]::IsWindowVisible($hWnd)) { return $true }
    $cls = New-Object System.Text.StringBuilder 256
    [AowuDrag]::GetClassName($hWnd, $cls, 256) | Out-Null
    if ($cls.ToString() -ne 'OWL.Dock') { return $true }
    $r = New-Object AowuDrag+RECT
    [AowuDrag]::GetWindowRect($hWnd, [ref]$r) | Out-Null
    $dw = $r.Right - $r.Left
    $dh = $r.Bottom - $r.Top
    if ($dw -lt 120 -or $dw -gt 900 -or $dh -lt 40 -or $dh -gt 1500) { return $true }
    $script:hasContent = $false
    $script:cw = 0
    $script:ch = 0
    [AowuDrag]::EnumChildWindows($hWnd, {
      param($child, $l2)
      $cc = New-Object System.Text.StringBuilder 256
      [AowuDrag]::GetClassName($child, $cc, 256) | Out-Null
      if ($cc.ToString() -eq 'PSViewC' -and [AowuDrag]::IsWindowVisible($child)) {
        $cr = New-Object AowuDrag+RECT
        [AowuDrag]::GetWindowRect($child, [ref]$cr) | Out-Null
        $w2 = $cr.Right - $cr.Left
        $h2 = $cr.Bottom - $cr.Top
        if ([Math]::Abs($w2 - $script:expectedW) -le 8 -and [Math]::Abs($h2 - $script:expectedH) -le 8) {
          $script:hasContent = $true
          $script:cw = $w2
          $script:ch = $h2
          $script:contentL = $cr.Left
          $script:contentT = $cr.Top
        }
      }
      return $true
    }, [IntPtr]::Zero) | Out-Null
    if ($script:hasContent) {
      [void]$script:candidates.Add([PSCustomObject]@{ H = $hWnd; CW = $script:cw; CH = $script:ch; Area = ($script:cw * $script:ch); DockL = $r.Left; DockT = $r.Top; RelL = ($script:contentL - $r.Left); RelT = ($script:contentT - $r.Top) })
    }
    return $true
  }, [IntPtr]::Zero) | Out-Null
  if ($script:candidates.Count -eq 0) { return $false }
  $best = $script:candidates | Sort-Object Area | Select-Object -First 1
  $script:target = [IntPtr]$best.H
  $script:contentW = [int]$best.CW
  $script:contentH = [int]$best.CH
  $script:contentRelL = [int]$best.RelL
  $script:contentRelT = [int]$best.RelT
  return $true
}

function Update-TargetRect {
  if ($script:target -eq [IntPtr]::Zero) { return }
  $r = New-Object AowuDrag+RECT
  if ([AowuDrag]::GetWindowRect($script:target, [ref]$r)) {
    $script:dockL = $r.Left
    $script:dockT = $r.Top
    $script:dockW = $r.Right - $r.Left
    $script:dockH = $r.Bottom - $r.Top
  }
}

function Apply-Clip {
  if ($script:target -eq [IntPtr]::Zero) { Find-PanelDock | Out-Null }
  if ($script:target -eq [IntPtr]::Zero) { return $false }
  if (-not $script:clipOn) {
    $r = New-Object AowuDrag+RECT
    [AowuDrag]::GetWindowRect($script:target, [ref]$r) | Out-Null
    $script:origDock = [PSCustomObject]@{ L = $r.Left; T = $r.Top; W = ($r.Right - $r.Left); H = ($r.Bottom - $r.Top) }
    $script:origContentRel = [PSCustomObject]@{ L = $script:contentRelL; T = $script:contentRelT }
    $script:clipOn = $true
  }
  $relL = $script:origContentRel.L
  $relT = $script:origContentRel.T
  $newX = $script:origDock.L - $relL
  $newY = $script:origDock.T - $relT
  [AowuDrag]::SetWindowPos($script:target, [IntPtr]::Zero, $newX, $newY, 0, 0, 0x0015) | Out-Null
  $rgn = [AowuDrag]::CreateRectRgn($relL, $relT, ($relL + $script:contentW), ($relT + $script:contentH))
  if ($rgn -ne [IntPtr]::Zero) { [AowuDrag]::SetWindowRgn($script:target, $rgn, $true) | Out-Null }
  return $true
}

function Clear-Clip {
  if ($script:target -eq [IntPtr]::Zero) { return $false }
  [AowuDrag]::SetWindowRgn($script:target, [IntPtr]::Zero, $true) | Out-Null
  if ($script:origDock) {
    [AowuDrag]::SetWindowPos($script:target, [IntPtr]::Zero, $script:origDock.L, $script:origDock.T, $script:origDock.W, $script:origDock.H, 0x0014) | Out-Null
    $script:origDock = $null
  }
  $script:clipOn = $false
  return $true
}

$lastFindAt = 0
$lastCtrl = ''
while ($true) {
  $psNow = Get-Process -Id $psPid -ErrorAction SilentlyContinue
  if (-not $psNow) { break }
  if (Test-Path $ctrlPath) {
    $txt = ''
    try { $txt = [System.IO.File]::ReadAllText($ctrlPath) } catch { $txt = '' }
    if ($txt -match 'stop') { if ($script:clipOn) { Clear-Clip | Out-Null }; try { Remove-Item -LiteralPath $ctrlPath -Force -ErrorAction SilentlyContinue } catch { }; break }
    if ($txt -and $txt -ne $lastCtrl) {
      $wantMatch = [regex]::Match($txt, 'want:\s*(\d+)\s*,\s*(\d+)')
      if ($wantMatch.Success) {
        $script:expectedW = [int]$wantMatch.Groups[1].Value
        $script:expectedH = [int]$wantMatch.Groups[2].Value
        $script:target = [IntPtr]::Zero
        $lastFindAt = 0
      }
      $unclipMatch = $txt -match 'unclip'
      $clipMatch = (-not $unclipMatch) -and ($txt -match 'clip')
      if ($unclipMatch) {
        Clear-Clip | Out-Null
      } elseif ($clipMatch) {
        if ($script:target -eq [IntPtr]::Zero) { Find-PanelDock | Out-Null }
        if ($script:target -ne [IntPtr]::Zero) { Apply-Clip | Out-Null }
      }
      $m = [regex]::Match($txt, 'move:\s*(-?\d+)\s*,\s*(-?\d+)')
      if ($m.Success) {
        if ($script:target -eq [IntPtr]::Zero) { Find-PanelDock | Out-Null }
        if ($script:target -ne [IntPtr]::Zero) {
          $x = [int]$m.Groups[1].Value
          $y = [int]$m.Groups[2].Value
          [AowuDrag]::SetWindowPos($script:target, [IntPtr]::Zero, $x, $y, 0, 0, 0x0015) | Out-Null
        }
      }
      $lastCtrl = $txt
      try { Remove-Item -LiteralPath $ctrlPath -Force -ErrorAction SilentlyContinue } catch { }
    }
  }
  $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if (-not $script:clipOn) {
    if (($script:target -eq [IntPtr]::Zero) -or (($nowMs - $lastFindAt) -gt 2500) -or (-not [AowuDrag]::IsWindowVisible($script:target))) {
      if ((Find-PanelDock)) { $lastFindAt = $nowMs }
    }
  } elseif (($script:target -ne [IntPtr]::Zero) -and (($nowMs - $script:lastClipAt) -gt 800)) {
    $relL = $script:origContentRel.L
    $relT = $script:origContentRel.T
    $rgn = [AowuDrag]::CreateRectRgn($relL, $relT, ($relL + $script:contentW), ($relT + $script:contentH))
    if ($rgn -ne [IntPtr]::Zero) { [AowuDrag]::SetWindowRgn($script:target, $rgn, $true) | Out-Null; $script:lastClipAt = $nowMs }
  }
  Write-Status $script:target $script:contentW $script:contentH
  Start-Sleep -Milliseconds 35
}
Write-Status ([IntPtr]::Zero) 0 0
try { Remove-Item -LiteralPath $ctrlPath -Force -ErrorAction SilentlyContinue } catch { }
try { $mutex.ReleaseMutex() } catch { }
