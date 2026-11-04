@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-windows.ps1"
set "gmoney_exit=%ERRORLEVEL%"
echo.
pause
endlocal & exit /b %gmoney_exit%
