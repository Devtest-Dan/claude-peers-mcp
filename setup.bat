@echo off
REM ============================================================
REM claude-peers LAN setup script (Windows)
REM
REM Usage:
REM   setup.bat                  — Join as a client
REM   setup.bat --broker         — Set up as broker host
REM   setup.bat --host 192.168.x.x --secret mysecret
REM ============================================================

setlocal enabledelayedexpansion

set "REPO_URL=https://github.com/Devtest-Dan/claude-peers-mcp.git"
set "INSTALL_DIR=%USERPROFILE%\claude-peers-mcp"
set "DEFAULT_BROKER_HOST=100.111.71.83"
set "DEFAULT_PORT=7899"
set "IS_BROKER=false"
set "BROKER_HOST="
set "SHARED_SECRET="

REM Parse arguments
:parse_args
if "%~1"=="" goto start
if "%~1"=="--broker" (set "IS_BROKER=true" & shift & goto parse_args)
if "%~1"=="--host" (set "BROKER_HOST=%~2" & shift & shift & goto parse_args)
if "%~1"=="--secret" (set "SHARED_SECRET=%~2" & shift & shift & goto parse_args)
if "%~1"=="--port" (set "DEFAULT_PORT=%~2" & shift & shift & goto parse_args)
if "%~1"=="--help" goto show_help
if "%~1"=="-h" goto show_help
echo [error] Unknown option: %~1
exit /b 1

:show_help
echo Usage: setup.bat [OPTIONS]
echo.
echo Options:
echo   --broker         Set up this machine as the broker host
echo   --host ^<ip^>      Broker IP address (default: %DEFAULT_BROKER_HOST%)
echo   --secret ^<key^>   Shared secret for authentication
echo   --port ^<port^>    Broker port (default: %DEFAULT_PORT%)
echo   --help           Show this help
exit /b 0

:start
echo.
echo ============================================
echo   claude-peers LAN Setup (Windows)
echo ============================================
echo.

REM --- Step 1: Check/install bun ---
echo [info] Checking for bun...
where bun >nul 2>&1
if %errorlevel%==0 (
    for /f "tokens=*" %%v in ('bun --version') do echo [ok] bun %%v already installed
) else (
    echo [info] Installing bun via npm...
    where npm >nul 2>&1
    if %errorlevel%==0 (
        call npm install -g bun
        echo [ok] bun installed
    ) else (
        echo [error] npm not found. Install Node.js or bun manually: https://bun.sh
        exit /b 1
    )
)

REM --- Step 2: Clone or update repo ---
echo [info] Setting up claude-peers-mcp...
if exist "%INSTALL_DIR%\.git" (
    echo [info] Repo exists, pulling latest...
    cd /d "%INSTALL_DIR%"
    git pull --ff-only origin main 2>nul || echo [warn] Could not pull latest
) else (
    echo [info] Cloning repository...
    git clone "%REPO_URL%" "%INSTALL_DIR%"
    cd /d "%INSTALL_DIR%"
)
echo [ok] Repository ready at %INSTALL_DIR%

REM --- Step 3: Install dependencies ---
echo [info] Installing dependencies...
cd /d "%INSTALL_DIR%"
call bun install
echo [ok] Dependencies installed

REM --- Step 4: Check Claude Code ---
echo [info] Checking for Claude Code...
where claude >nul 2>&1
if %errorlevel%==0 (
    echo [ok] Claude Code found
) else (
    echo [warn] Claude Code CLI not found. Install it before using claude-peers.
)

REM --- Step 5: Register MCP server ---
echo [info] Registering claude-peers MCP server...
where claude >nul 2>&1
if %errorlevel%==0 (
    claude mcp remove --scope user claude-peers 2>nul
    claude mcp add --scope user --transport stdio claude-peers -- bun "%INSTALL_DIR%\server.ts"
    echo [ok] MCP server registered
) else (
    echo [warn] Skipping MCP registration - install Claude Code first
    echo   Then run: claude mcp add --scope user --transport stdio claude-peers -- bun "%INSTALL_DIR%\server.ts"
)

REM --- Step 6: Configure environment ---
if "%IS_BROKER%"=="true" (
    echo.
    echo [ok] Broker host configured!
    echo.
    echo   Start the broker with:
    echo.
    if not "%SHARED_SECRET%"=="" (
        echo     set CLAUDE_PEERS_BIND=lan ^& set CLAUDE_PEERS_SECRET=%SHARED_SECRET% ^& bun "%INSTALL_DIR%\broker.ts"
    ) else (
        echo     set CLAUDE_PEERS_BIND=lan ^& bun "%INSTALL_DIR%\broker.ts"
    )
    echo.
    echo   Tell team members to run:
    echo     setup.bat --host YOUR_LAN_IP
    goto done
)

REM Client setup
if "%BROKER_HOST%"=="" (
    echo.
    set /p "BROKER_HOST=  Broker host IP [%DEFAULT_BROKER_HOST%]: "
    if "!BROKER_HOST!"=="" set "BROKER_HOST=%DEFAULT_BROKER_HOST%"
)

if "%SHARED_SECRET%"=="" (
    echo.
    set /p "SHARED_SECRET=  Shared secret (press Enter to skip): "
)

REM Set environment variables permanently for the user
echo [info] Setting environment variables...
setx CLAUDE_PEERS_HOST "%BROKER_HOST%" >nul 2>&1
setx CLAUDE_PEERS_PORT "%DEFAULT_PORT%" >nul 2>&1
if not "%SHARED_SECRET%"=="" (
    setx CLAUDE_PEERS_SECRET "%SHARED_SECRET%" >nul 2>&1
)
echo [ok] Environment variables set (restart terminal for effect)

REM Also set for current session
set "CLAUDE_PEERS_HOST=%BROKER_HOST%"
set "CLAUDE_PEERS_PORT=%DEFAULT_PORT%"

REM --- Test broker connection ---
echo.
echo [info] Testing broker connection at %BROKER_HOST%:%DEFAULT_PORT%...
curl -s --connect-timeout 3 "http://%BROKER_HOST%:%DEFAULT_PORT%/health" >nul 2>&1
if %errorlevel%==0 (
    echo [ok] Broker is reachable!
) else (
    echo [warn] Broker at %BROKER_HOST%:%DEFAULT_PORT% is not reachable.
    echo [warn] Make sure the broker is running on the host machine.
)

:done
echo.
echo ============================================
echo   Setup complete!
echo ============================================
echo.
echo   Launch Claude Code with peers:
echo     claude --dangerously-skip-permissions --dangerously-load-development-channels server:claude-peers
echo.
echo   Check broker status:
echo     bun "%INSTALL_DIR%\cli.ts" status
echo.
echo   List peers:
echo     bun "%INSTALL_DIR%\cli.ts" peers
echo.

endlocal
