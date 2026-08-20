@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "XIAOAI_PROJECT_ROOT=%SCRIPT_DIR%"
if exist "%SCRIPT_DIR%\scripts\install\install.cmd" (
  call "%SCRIPT_DIR%\scripts\install\install.cmd" %*
  exit /b !ERRORLEVEL!
)

set "RELEASE_ARCHIVE="
for %%F in ("%SCRIPT_DIR%\openclaw-plugin-xiaoai-cloud-bundle.zip") do if exist "%%~fF" set "RELEASE_ARCHIVE=%%~fF"
if not defined RELEASE_ARCHIVE for %%F in ("%SCRIPT_DIR%\openclaw-plugin-xiaoai-cloud-*.zip") do if exist "%%~fF" set "RELEASE_ARCHIVE=%%~fF"
if not defined RELEASE_ARCHIVE for %%F in ("%SCRIPT_DIR%\openclaw-plugin-xiaoai-cloud-bundle.tar.gz") do if exist "%%~fF" set "RELEASE_ARCHIVE=%%~fF"
if not defined RELEASE_ARCHIVE for %%F in ("%SCRIPT_DIR%\openclaw-plugin-xiaoai-cloud-*.tgz") do if exist "%%~fF" set "RELEASE_ARCHIVE=%%~fF"
if not defined RELEASE_ARCHIVE for %%F in ("%SCRIPT_DIR%\openclaw-plugin-xiaoai-cloud-*.tar.gz") do if exist "%%~fF" set "RELEASE_ARCHIVE=%%~fF"
if not defined RELEASE_ARCHIVE (
  echo Missing installer implementation: %SCRIPT_DIR%\scripts\install\install.cmd
  echo Place the complete Release bundle beside install.cmd, or run it from the bundle root.
  exit /b 1
)

set "TEMP_RELEASE_DIR=%TEMP%\xiaoai-install-entry-%RANDOM%%RANDOM%"
mkdir "%TEMP_RELEASE_DIR%" >nul 2>nul || (
  echo Failed to create temporary directory: %TEMP_RELEASE_DIR%
  exit /b 1
)
if /i "%RELEASE_ARCHIVE:~-4%"==".zip" (
  powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '%RELEASE_ARCHIVE%' -DestinationPath '%TEMP_RELEASE_DIR%' -Force" || exit /b 1
) else (
  tar -xzf "%RELEASE_ARCHIVE%" -C "%TEMP_RELEASE_DIR%" || exit /b 1
)

for %%R in ("%TEMP_RELEASE_DIR%\openclaw-plugin-xiaoai-cloud" "%TEMP_RELEASE_DIR%\package" "%TEMP_RELEASE_DIR%") do (
  if exist "%%~fR\scripts\install\install.cmd" (
    set "XIAOAI_PROJECT_ROOT=%%~fR"
    call "%%~fR\scripts\install\install.cmd" %*
    exit /b !ERRORLEVEL!
  )
  if exist "%%~fR\install.cmd" (
    set "XIAOAI_PROJECT_ROOT=%%~fR"
    call "%%~fR\install.cmd" %*
    exit /b !ERRORLEVEL!
  )
)
echo Failed to locate an installer in %RELEASE_ARCHIVE%
exit /b %ERRORLEVEL%
