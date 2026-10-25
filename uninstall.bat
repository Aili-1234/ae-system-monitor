@echo off
setlocal EnableExtensions
title AE System Monitor - Uninstaller

set "DEST=%APPDATA%\Adobe\CEP\extensions\AESystemMonitor"

echo.
echo   AE System Monitor - Uninstall
echo   Target: %DEST%
echo.

if exist "%DEST%" (
    rmdir /s /q "%DEST%" 2>nul
    echo   [OK] Panel folder removed.
) else (
    echo   [--] Nothing to remove.
)

echo.
echo   Note: PlayerDebugMode registry key was left untouched
echo         because other unsigned panels may still need it.
echo         Restart After Effects to finish.
echo.
pause
