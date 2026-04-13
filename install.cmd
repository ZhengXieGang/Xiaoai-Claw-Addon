@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "SOURCE_DIR=%SCRIPT_DIR%"
set "TEMP_RELEASE_DIR="
set "DEV_MODE=0"
set "PROFILE="
set "STATE_DIR=%OPENCLAW_STATE_DIR%"
set "SKIP_NPM_INSTALL=0"
set "PACKAGE_MANAGER=auto"
set "OPENCLAW_BIN=%OPENCLAW_BIN%"
set "MIN_OPENCLAW_VERSION=2026.03.24"
set "HAS_SOURCE_TREE=0"
set "EXIT_CODE=0"
set "LOG_FILE=%XIAOAI_INSTALL_LOG_FILE%"
set "CURRENT_STAGE=bootstrap"
if "%OPENCLAW_BIN%"=="" set "OPENCLAW_BIN=openclaw"

:parse_args
if "%~1"=="" goto after_args
if /i "%~1"=="--dev" (
  set "DEV_MODE=1"
  shift
  goto parse_args
)
if /i "%~1"=="--skip-npm-install" (
  set "SKIP_NPM_INSTALL=1"
  shift
  goto parse_args
)
if /i "%~1"=="--profile" (
  if "%~2"=="" (
    echo Missing value for --profile
    set "EXIT_CODE=1"
    goto cleanup_and_exit
  )
  set "PROFILE=%~2"
  shift
  shift
  goto parse_args
)
if /i "%~1"=="--state-dir" (
  if "%~2"=="" (
    echo Missing value for --state-dir
    set "EXIT_CODE=1"
    goto cleanup_and_exit
  )
  set "STATE_DIR=%~2"
  shift
  shift
  goto parse_args
)
if /i "%~1"=="--package-manager" (
  if "%~2"=="" (
    echo Missing value for --package-manager
    set "EXIT_CODE=1"
    goto cleanup_and_exit
  )
  set "PACKAGE_MANAGER=%~2"
  shift
  shift
  goto parse_args
)
if /i "%~1"=="--openclaw-bin" (
  if "%~2"=="" (
    echo Missing value for --openclaw-bin
    set "EXIT_CODE=1"
    goto cleanup_and_exit
  )
  set "OPENCLAW_BIN=%~2"
  shift
  shift
  goto parse_args
)
if /i "%~1"=="--log-file" (
  if "%~2"=="" (
    echo Missing value for --log-file
    set "EXIT_CODE=1"
    goto cleanup_and_exit
  )
  set "LOG_FILE=%~2"
  shift
  shift
  goto parse_args
)
if /i "%~1"=="--help" goto help_ok
if /i "%~1"=="-h" goto help_ok

echo Unknown option: %~1
goto help_error

:help_ok
call :print_help
set "EXIT_CODE=0"
goto cleanup_and_exit

:help_error
call :print_help
set "EXIT_CODE=1"
goto cleanup_and_exit

:after_args
call :init_log_file
call :set_stage preflight
call :prepare_source_dir || (set "EXIT_CODE=1" & goto cleanup_and_exit)

where node >nul 2>nul || (echo Missing required command: node & set "EXIT_CODE=1" & goto cleanup_and_exit)
call :ensure_node_supported || (set "EXIT_CODE=1" & goto cleanup_and_exit)
call :detect_package_manager || (set "EXIT_CODE=1" & goto cleanup_and_exit)
where %PKG_MANAGER% >nul 2>nul || (echo Missing required command: %PKG_MANAGER% & set "EXIT_CODE=1" & goto cleanup_and_exit)
call :ensure_openclaw_bin || (set "EXIT_CODE=1" & goto cleanup_and_exit)
call :ensure_supported_openclaw || (set "EXIT_CODE=1" & goto cleanup_and_exit)
call :detect_source_tree

cd /d "%SOURCE_DIR%" || (echo Failed to enter source directory: %SOURCE_DIR% & set "EXIT_CODE=1" & goto cleanup_and_exit)

if "%SKIP_NPM_INSTALL%"=="0" (
  if "%HAS_SOURCE_TREE%"=="1" (
    call :set_stage install_dependencies
    call :log_info [1/5] Installing dependencies with %PKG_MANAGER%...
    if /i "%PKG_MANAGER%"=="pnpm" (
      call pnpm install --no-frozen-lockfile >> "%LOG_FILE%" 2>&1 || (set "EXIT_CODE=1" & goto cleanup_and_exit)
    ) else (
      call npm install >> "%LOG_FILE%" 2>&1 || (set "EXIT_CODE=1" & goto cleanup_and_exit)
    )
  ) else (
    call :set_stage install_runtime_dependencies
    call :log_info [1/5] Installing runtime dependencies with %PKG_MANAGER%...
    if /i "%PKG_MANAGER%"=="pnpm" (
      call pnpm install --prod --no-frozen-lockfile >> "%LOG_FILE%" 2>&1 || (set "EXIT_CODE=1" & goto cleanup_and_exit)
    ) else (
      if exist "%SOURCE_DIR%\package-lock.json" (
        call npm ci --omit=dev >> "%LOG_FILE%" 2>&1 || (call npm install --omit=dev >> "%LOG_FILE%" 2>&1 || (set "EXIT_CODE=1" & goto cleanup_and_exit))
      ) else (
        call npm install --omit=dev >> "%LOG_FILE%" 2>&1 || (set "EXIT_CODE=1" & goto cleanup_and_exit)
      )
    )
  )
)

if "%HAS_SOURCE_TREE%"=="1" (
  call :set_stage build_plugin
  call :log_info [2/5] Building plugin...
  if /i "%PKG_MANAGER%"=="pnpm" (
    call pnpm run build >> "%LOG_FILE%" 2>&1 || (set "EXIT_CODE=1" & goto cleanup_and_exit)
  ) else (
    call npm run build >> "%LOG_FILE%" 2>&1 || (set "EXIT_CODE=1" & goto cleanup_and_exit)
  )
) else (
  call :log_info [2/5] Using prebuilt release bundle, skipping build...
)

call :set_stage install_plugin
call :log_info [3/5] Installing plugin into OpenClaw...
call :resolve_plugin_install_safety_flag
if not "%DEV_MODE%"=="1" (
  call :run_openclaw plugins inspect openclaw-plugin-xiaoai-cloud --json >nul 2>nul
  if not errorlevel 1 (
    call :log_info [3/5] Existing plugin detected, uninstalling old version...
    call :run_openclaw plugins uninstall openclaw-plugin-xiaoai-cloud --force >> "%LOG_FILE%" 2>&1
    if errorlevel 1 (
      call :log_warn [3/5] OpenClaw 标准卸载失败，正在清理残留插件目录和配置...
      call :cleanup_unmanaged_plugin_install || (set "EXIT_CODE=1" & goto cleanup_and_exit)
    ) else (
      call :cleanup_unmanaged_plugin_install || (set "EXIT_CODE=1" & goto cleanup_and_exit)
    )
  )
)
if "%DEV_MODE%"=="1" (
  if defined PLUGIN_INSTALL_SAFETY_FLAG (
    call :run_openclaw plugins install %PLUGIN_INSTALL_SAFETY_FLAG% -l "%SOURCE_DIR%" >> "%LOG_FILE%" 2>&1 || (set "EXIT_CODE=1" & goto cleanup_and_exit)
  ) else (
    call :run_openclaw plugins install -l "%SOURCE_DIR%" >> "%LOG_FILE%" 2>&1 || (set "EXIT_CODE=1" & goto cleanup_and_exit)
  )
) else (
  if defined PLUGIN_INSTALL_SAFETY_FLAG (
    call :run_openclaw plugins install %PLUGIN_INSTALL_SAFETY_FLAG% "%SOURCE_DIR%" >> "%LOG_FILE%" 2>&1 || (set "EXIT_CODE=1" & goto cleanup_and_exit)
  ) else (
    call :run_openclaw plugins install "%SOURCE_DIR%" >> "%LOG_FILE%" 2>&1 || (set "EXIT_CODE=1" & goto cleanup_and_exit)
  )
)

call :set_stage configure_openclaw
call :log_info [4/5] Configuring dedicated lightweight XiaoAi agent...
set "CONFIGURE_ARGS=--openclaw-bin ""%OPENCLAW_BIN%"""
if not "%PROFILE%"=="" set "CONFIGURE_ARGS=%CONFIGURE_ARGS% --profile ""%PROFILE%"""
if not "%STATE_DIR%"=="" set "CONFIGURE_ARGS=%CONFIGURE_ARGS% --state-dir ""%STATE_DIR%"""
if defined LOG_FILE set "CONFIGURE_ARGS=%CONFIGURE_ARGS% --log-file ""%LOG_FILE%"""
set "XIAOAI_INSTALL_LOG_CAPTURED=1"
set "XIAOAI_INSTALL_LOG_FILE=%LOG_FILE%"
call node "%SOURCE_DIR%\scripts\configure-openclaw-install.mjs" %CONFIGURE_ARGS% >> "%LOG_FILE%" 2>&1 || (set "EXIT_CODE=1" & goto cleanup_and_exit)

call :set_stage inspect_and_restart
call :log_info [5/5] Inspecting plugin and restarting gateway...
call :run_openclaw plugins inspect openclaw-plugin-xiaoai-cloud --json >> "%LOG_FILE%" 2>&1 || (set "EXIT_CODE=1" & goto cleanup_and_exit)
call :run_openclaw gateway restart >> "%LOG_FILE%" 2>&1 || (set "EXIT_CODE=1" & goto cleanup_and_exit)

echo.
echo Done. Next step:
echo   1. Call xiaoai_console_open
echo   2. Open the console link
echo   3. Log in and choose a XiaoAi speaker
if defined LOG_FILE echo [install] Full log saved to %LOG_FILE%
set "EXIT_CODE=0"
goto cleanup_and_exit

:print_help
echo Usage: install.cmd [options]
echo.
echo   --dev                  Install in local link mode ^(openclaw plugins install -l^)
echo   --profile NAME         Use the given OpenClaw profile
echo   --state-dir DIR        Use the given OpenClaw state dir
echo   --package-manager PM   Package manager: auto ^| npm ^| pnpm
echo   --openclaw-bin CMD     OpenClaw CLI path or wrapper script path
echo   --log-file PATH        Persist installer log to PATH
echo   --skip-npm-install     Skip dependency install and build/runtime install step
echo   --help                 Show this help message
echo.
echo Notes:
echo   - You can run this script in the source repo directory.
echo   - You can also place this script beside a GitHub Release bundle archive
echo     ^(openclaw-plugin-xiaoai-cloud-bundle.zip^), and it will
echo     auto-extract and install from that bundle.
echo   - Older .tar.gz / .tgz release bundles are still supported for backward compatibility.
echo   - If your OpenClaw gateway runs in Docker or on a remote server, run this script
echo     inside that same container / host environment.
echo   - If OpenClaw is not on PATH, pass --openclaw-bin with a local wrapper script path.
echo   - Requires OpenClaw %MIN_OPENCLAW_VERSION% or newer.
echo   - On failure, the script will print the failing stage and the installer log path.
exit /b 0

:init_log_file
if defined LOG_FILE goto init_log_ready
set "STAMP="
for /f %%v in ('powershell -NoLogo -NoProfile -NonInteractive -Command "Get-Date -Format yyyyMMdd-HHmmss" 2^>NUL') do set "STAMP=%%v"
if not defined STAMP set "STAMP=%RANDOM%%RANDOM%"
set "LOG_DIR=%SCRIPT_DIR%\install-logs"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>nul
set "LOG_FILE=%LOG_DIR%\xiaoai-install-%STAMP%.log"
:init_log_ready
type nul > "%LOG_FILE%" 2>nul
call :log_info Installer log: %LOG_FILE%
exit /b 0

:log_info
echo %*
if defined LOG_FILE >> "%LOG_FILE%" echo [%DATE% %TIME%] [INFO] %*
exit /b 0

:log_warn
echo %*
if defined LOG_FILE >> "%LOG_FILE%" echo [%DATE% %TIME%] [WARN] %*
exit /b 0

:set_stage
set "CURRENT_STAGE=%~1"
call :log_info Stage: %CURRENT_STAGE%
exit /b 0

:prepare_source_dir
if exist "%SOURCE_DIR%\package.json" exit /b 0

call :find_release_archive
if errorlevel 1 exit /b 1
if not defined RELEASE_ARCHIVE (
  echo No package.json found in %SCRIPT_DIR%, and no release bundle archive was found beside install.cmd.
  echo Expected: openclaw-plugin-xiaoai-cloud-bundle.zip
  echo Older .tar.gz / .tgz release bundles are still accepted if you already have one.
  exit /b 1
)

set "TEMP_RELEASE_DIR=%TEMP%\xiaoai-cloud-install-%RANDOM%%RANDOM%%RANDOM%"
mkdir "%TEMP_RELEASE_DIR%" >nul 2>nul || (
  echo Failed to create temporary directory: %TEMP_RELEASE_DIR%
  exit /b 1
)

echo [prepare] Extracting release bundle: %RELEASE_ARCHIVE_NAME%
call :extract_release_archive "%RELEASE_ARCHIVE%" "%TEMP_RELEASE_DIR%" || exit /b 1
call :resolve_extracted_source_dir "%TEMP_RELEASE_DIR%" || exit /b 1
if not defined RESOLVED_SOURCE_DIR (
  echo Failed to locate package.json after extracting release bundle.
  exit /b 1
)

set "SOURCE_DIR=%RESOLVED_SOURCE_DIR%"
exit /b 0

:find_release_archive
set "RELEASE_ARCHIVE="
set "RELEASE_ARCHIVE_NAME="
for %%F in ("%SCRIPT_DIR%\openclaw-plugin-xiaoai-cloud-bundle.zip") do if exist "%%~fF" (
  set "RELEASE_ARCHIVE=%%~fF"
  set "RELEASE_ARCHIVE_NAME=%%~nxF"
  exit /b 0
)
for %%F in ("%SCRIPT_DIR%\openclaw-plugin-xiaoai-cloud-*.zip") do if exist "%%~fF" (
  set "RELEASE_ARCHIVE=%%~fF"
  set "RELEASE_ARCHIVE_NAME=%%~nxF"
  exit /b 0
)
for %%F in ("%SCRIPT_DIR%\openclaw-plugin-xiaoai-cloud-bundle.tar.gz") do if exist "%%~fF" (
  set "RELEASE_ARCHIVE=%%~fF"
  set "RELEASE_ARCHIVE_NAME=%%~nxF"
  exit /b 0
)
for %%F in ("%SCRIPT_DIR%\openclaw-plugin-xiaoai-cloud-*.tgz") do if exist "%%~fF" (
  set "RELEASE_ARCHIVE=%%~fF"
  set "RELEASE_ARCHIVE_NAME=%%~nxF"
  exit /b 0
)
for %%F in ("%SCRIPT_DIR%\openclaw-plugin-xiaoai-cloud-*.tar.gz") do if exist "%%~fF" (
  set "RELEASE_ARCHIVE=%%~fF"
  set "RELEASE_ARCHIVE_NAME=%%~nxF"
  exit /b 0
)
exit /b 0

:extract_release_archive
set "ARCHIVE_PATH=%~1"
set "TARGET_DIR=%~2"
if /i "%ARCHIVE_PATH:~-4%"==".zip" (
  call :extract_zip "%ARCHIVE_PATH%" "%TARGET_DIR%" || exit /b 1
  exit /b 0
)
if /i "%ARCHIVE_PATH:~-7%"==".tar.gz" (
  call :extract_targz "%ARCHIVE_PATH%" "%TARGET_DIR%" || exit /b 1
  exit /b 0
)
if /i "%ARCHIVE_PATH:~-4%"==".tgz" (
  call :extract_targz "%ARCHIVE_PATH%" "%TARGET_DIR%" || exit /b 1
  exit /b 0
)
echo Unsupported release bundle archive: %ARCHIVE_PATH%
exit /b 1

:extract_zip
where powershell >nul 2>nul && (
  powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "param([string]$archive,[string]$target) Expand-Archive -LiteralPath $archive -DestinationPath $target -Force" "%~1" "%~2" || exit /b 1
  exit /b 0
)
where pwsh >nul 2>nul && (
  pwsh -NoLogo -NoProfile -NonInteractive -Command "param([string]$archive,[string]$target) Expand-Archive -LiteralPath $archive -DestinationPath $target -Force" "%~1" "%~2" || exit /b 1
  exit /b 0
)
where tar >nul 2>nul && (
  tar -xf "%~1" -C "%~2" || exit /b 1
  exit /b 0
)
echo Missing required command to extract zip archive: powershell / pwsh / tar
exit /b 1

:extract_targz
where tar >nul 2>nul || (
  echo Missing required command to extract tar.gz archive: tar
  exit /b 1
)
tar -xzf "%~1" -C "%~2" || exit /b 1
exit /b 0

:resolve_extracted_source_dir
set "RESOLVED_SOURCE_DIR="
if exist "%~1\openclaw-plugin-xiaoai-cloud\package.json" (
  set "RESOLVED_SOURCE_DIR=%~1\openclaw-plugin-xiaoai-cloud"
  exit /b 0
)
if exist "%~1\package\package.json" (
  set "RESOLVED_SOURCE_DIR=%~1\package"
  exit /b 0
)
for /r "%~1" %%F in (package.json) do if not defined RESOLVED_SOURCE_DIR (
  set "RESOLVED_SOURCE_DIR=%%~dpF"
)
if defined RESOLVED_SOURCE_DIR if "!RESOLVED_SOURCE_DIR:~-1!"=="\" set "RESOLVED_SOURCE_DIR=!RESOLVED_SOURCE_DIR:~0,-1!"
if defined RESOLVED_SOURCE_DIR exit /b 0
exit /b 1

:detect_source_tree
set "HAS_SOURCE_TREE=0"
if exist "%SOURCE_DIR%\src" if exist "%SOURCE_DIR%\index.ts" if exist "%SOURCE_DIR%\tsconfig.json" set "HAS_SOURCE_TREE=1"
exit /b 0

:ensure_node_supported
for /f %%v in ('node -p "Number(process.versions.node.split('.')[0] ^|^| 0)"') do set "NODE_MAJOR=%%v"
if not defined NODE_MAJOR (
  echo Failed to detect Node.js version.
  exit /b 1
)
if %NODE_MAJOR% LSS 22 (
  for /f %%v in ('node -p "process.versions.node"') do set "NODE_VERSION=%%v"
  echo Node.js %NODE_VERSION% is too old. OpenClaw 官方文档要求插件环境使用 Node.js 22 或更高版本。
  exit /b 1
)
exit /b 0

:detect_package_manager
if /i "%PACKAGE_MANAGER%"=="npm" (
  set "PKG_MANAGER=npm"
  exit /b 0
)
if /i "%PACKAGE_MANAGER%"=="pnpm" (
  set "PKG_MANAGER=pnpm"
  exit /b 0
)
if /i not "%PACKAGE_MANAGER%"=="auto" (
  echo Unsupported package manager: %PACKAGE_MANAGER%
  exit /b 1
)
if exist "%SOURCE_DIR%\package-lock.json" (
  where npm >nul 2>nul && (set "PKG_MANAGER=npm" & exit /b 0)
)
if exist "%SOURCE_DIR%\pnpm-lock.yaml" (
  where pnpm >nul 2>nul && (set "PKG_MANAGER=pnpm" & exit /b 0)
)
where npm >nul 2>nul && (set "PKG_MANAGER=npm" & exit /b 0)
where pnpm >nul 2>nul && (set "PKG_MANAGER=pnpm" & exit /b 0)
echo Missing required command: npm or pnpm
exit /b 1

:ensure_openclaw_bin
if exist "%OPENCLAW_BIN%" exit /b 0
where "%OPENCLAW_BIN%" >nul 2>nul && exit /b 0
echo OpenClaw CLI not found: %OPENCLAW_BIN%
exit /b 1

:ensure_supported_openclaw
set "OPENCLAW_VERSION_OUTPUT="
for /f "usebackq delims=" %%v in (`call "%OPENCLAW_BIN%" --version 2^>^&1`) do set "OPENCLAW_VERSION_OUTPUT=%%v"
if not defined OPENCLAW_VERSION_OUTPUT (
  echo Failed to detect OpenClaw version from %OPENCLAW_BIN%.
  exit /b 1
)
node -e "const raw=(process.argv[1]||'').trim(); const min=[2026,3,24]; const match=raw.match(/(\d{4})\.(\d{1,2})\.(\d{1,2})/); if (!match) process.exit(2); const current=match.slice(1).map(Number); for (let i=0; i<min.length; i+=1) { if (current[i] > min[i]) process.exit(0); if (current[i] < min[i]) process.exit(1); } process.exit(0);" "%OPENCLAW_VERSION_OUTPUT%" >nul 2>nul
set "OPENCLAW_VERSION_STATUS=%ERRORLEVEL%"
if "%OPENCLAW_VERSION_STATUS%"=="0" exit /b 0
if "%OPENCLAW_VERSION_STATUS%"=="2" (
  echo Failed to parse OpenClaw version from: %OPENCLAW_VERSION_OUTPUT%
  echo This installer requires OpenClaw %MIN_OPENCLAW_VERSION% or newer.
  exit /b 1
)
echo OpenClaw %OPENCLAW_VERSION_OUTPUT% is too old. This plugin requires OpenClaw %MIN_OPENCLAW_VERSION% or newer because it depends on the new plugin SDK / Gateway runtime.
exit /b 1

:run_openclaw
setlocal
if not "%STATE_DIR%"=="" set "OPENCLAW_STATE_DIR=%STATE_DIR%"
if not "%PROFILE%"=="" (
  call "%OPENCLAW_BIN%" --profile "%PROFILE%" %*
) else (
  call "%OPENCLAW_BIN%" %*
)
set "RUN_EXIT=%ERRORLEVEL%"
endlocal & exit /b %RUN_EXIT%

:resolve_plugin_install_safety_flag
set "PLUGIN_INSTALL_SAFETY_FLAG="
for /f "delims=" %%L in ('call :run_openclaw plugins install --help ^| findstr /c:"--dangerously-force-unsafe-install"') do (
  set "PLUGIN_INSTALL_SAFETY_FLAG=--dangerously-force-unsafe-install"
)
exit /b 0

:cleanup_unmanaged_plugin_install
setlocal
set "ACTIVE_STATE_DIR=%STATE_DIR%"
if "%ACTIVE_STATE_DIR%"=="" set "ACTIVE_STATE_DIR=%OPENCLAW_STATE_DIR%"
if "%ACTIVE_STATE_DIR%"=="" set "ACTIVE_STATE_DIR=%USERPROFILE%\.openclaw"
if exist "%ACTIVE_STATE_DIR%\extensions\openclaw-plugin-xiaoai-cloud" rmdir /s /q "%ACTIVE_STATE_DIR%\extensions\openclaw-plugin-xiaoai-cloud" >nul 2>nul
if exist "%ACTIVE_STATE_DIR%\plugins\openclaw-plugin-xiaoai-cloud" rmdir /s /q "%ACTIVE_STATE_DIR%\plugins\openclaw-plugin-xiaoai-cloud" >nul 2>nul
set "CONFIG_FILE=%ACTIVE_STATE_DIR%\openclaw.json"
if exist "%CONFIG_FILE%" (
  node -e "const fs=require('fs'); const filePath=process.argv[1]; const raw=fs.readFileSync(filePath,'utf8'); let config; try { config=JSON.parse(raw); } catch { const JSON5=require('json5'); config=JSON5.parse(raw); } if (config && typeof config==='object' && config.plugins && typeof config.plugins==='object') { if (config.plugins.entries && typeof config.plugins.entries==='object') delete config.plugins.entries['openclaw-plugin-xiaoai-cloud']; if (Array.isArray(config.plugins.allow)) config.plugins.allow=config.plugins.allow.filter((item)=>item!=='openclaw-plugin-xiaoai-cloud'); } fs.writeFileSync(filePath, JSON.stringify(config,null,2)+'\n', 'utf8');" "%CONFIG_FILE%" || (endlocal & exit /b 1)
)
endlocal & exit /b 0

:cleanup_and_exit
if not "%EXIT_CODE%"=="0" (
  echo [install] Failed during stage: %CURRENT_STAGE%
  if defined LOG_FILE echo [install] Installer log: %LOG_FILE%
)
if defined TEMP_RELEASE_DIR if exist "%TEMP_RELEASE_DIR%" rmdir /s /q "%TEMP_RELEASE_DIR%" >nul 2>nul
exit /b %EXIT_CODE%
