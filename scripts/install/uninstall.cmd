@echo off
setlocal EnableExtensions

set "ENTRY_DIR=%~dp0"
if "%ENTRY_DIR:~-1%"=="\" set "ENTRY_DIR=%ENTRY_DIR:~0,-1%"
set "SCRIPT_DIR=%XIAOAI_PROJECT_ROOT%"
if not defined SCRIPT_DIR set "SCRIPT_DIR=%ENTRY_DIR%"
if not exist "%SCRIPT_DIR%\package.json" if exist "%ENTRY_DIR%\..\..\package.json" set "SCRIPT_DIR=%ENTRY_DIR%\..\.."
for %%I in ("%SCRIPT_DIR%") do set "SCRIPT_DIR=%%~fI"

where node >nul 2>nul || (
  echo Missing required command: node
  exit /b 1
)

node "%SCRIPT_DIR%\scripts\configure-openclaw-uninstall.mjs" %*
exit /b %ERRORLEVEL%
