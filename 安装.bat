@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
echo.
echo  =============================================
echo    嗷呜计数 v1.4.0 - 安装程序
echo  =============================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
set "EXITCODE=%ERRORLEVEL%"
echo.
if "%EXITCODE%"=="0" (
  echo  安装完成。按任意键关闭窗口。
) else (
  echo  安装失败 - 错误码 %EXITCODE%。请查看上方提示。
)
pause >nul
exit /b %EXITCODE%
