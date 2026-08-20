@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "XIAOAI_PROJECT_ROOT=%SCRIPT_DIR%"
if exist "%SCRIPT_DIR%\scripts\install\uninstall.cmd" (
  call "%SCRIPT_DIR%\scripts\install\uninstall.cmd" %*
  exit /b !ERRORLEVEL!
)
if exist "%SCRIPT_DIR%\scripts\configure-openclaw-uninstall.mjs" (
  node "%SCRIPT_DIR%\scripts\configure-openclaw-uninstall.mjs" %*
  exit /b !ERRORLEVEL!
)
echo Missing uninstaller implementation: %SCRIPT_DIR%\scripts\install\uninstall.cmd
echo Run uninstall.cmd from a complete Release bundle or repository checkout.
exit /b 1
exit /b %ERRORLEVEL%
