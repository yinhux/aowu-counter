@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
echo.
echo  =============================================
echo    嗷呜计数 - 卸载程序
echo  =============================================
echo.
echo  提示：卸载默认保留计数数据；如需同时删除数据，
echo  请运行 powershell -File uninstall.ps1 -RemoveData
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1"
set "EXITCODE=%ERRORLEVEL%"
echo.
if "%EXITCODE%"=="0" (
  echo  卸载完成。按任意键关闭窗口。
) else (
  echo  卸载失败 - 错误码 %EXITCODE%。请查看上方提示。
)
pause >nul
exit /b %EXITCODE%
