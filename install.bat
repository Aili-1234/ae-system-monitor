@echo off
setlocal EnableExtensions
title AE System Monitor - Installer

set "SRC=%~dp0"
set "DEST=%APPDATA%\Adobe\CEP\extensions\AESystemMonitor"

echo.
echo  ==========================================
echo    AE System Monitor - CEP Panel Installer
echo  ==========================================
echo.
echo   Source : %SRC%
echo   Target : %DEST%
echo.

if not exist "%APPDATA%\Adobe\CEP\extensions" (
    mkdir "%APPDATA%\Adobe\CEP\extensions" 2>nul
)

if exist "%DEST%" (
    echo   [1/3] Removing previous installation...
    rmdir /s /q "%DEST%" 2>nul
) else (
    echo   [1/3] Fresh install.
)

echo   [2/3] Copying extension files...
mkdir "%DEST%" 2>nul
xcopy "%SRC%CSXS"       "%DEST%\CSXS"       /E /I /Y /Q >nul
xcopy "%SRC%js"         "%DEST%\js"         /E /I /Y /Q >nul
xcopy "%SRC%css"        "%DEST%\css"        /E /I /Y /Q >nul
xcopy "%SRC%jsx"        "%DEST%\jsx"        /E /I /Y /Q >nul
copy /y "%SRC%index.html" "%DEST%\index.html" >nul

echo   [3/3] Enabling unsigned-panel debug mode...
rem CSXS 6~12 对应 CEP 6 ~ CEP 12，覆盖 AE CC 2015.3 ~ 2025+
rem 只写当前存在的版本也没关系：不存在的键会被直接创建，不影响宿主
for %%V in (6 7 8 9 10 11 12) do (
    reg add "HKCU\Software\Adobe\CSXS.%%V" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1
)

echo.
if exist "%DEST%\index.html" (
    echo   [OK] Installed successfully.
) else (
    echo   [FAIL] Copy failed. Please check folder permissions.
)
echo.
echo   Next steps:
echo     1. Restart After Effects completely.
echo     2. Menu: Window ^> Extensions ^> System Monitor
echo     3. Dock the panel wherever you like.
echo.
pause
