@echo off
REM ============================================================
REM claude-peers: One-command team setup (Windows)
REM
REM Run this ONCE and you're connected forever.
REM ============================================================

setlocal enabledelayedexpansion

set "REPO_URL=https://github.com/Devtest-Dan/claude-peers-mcp.git"
set "INSTALL_DIR=%USERPROFILE%\claude-peers-mcp"
set "BROKER_HOST=100.111.71.83"
set "BROKER_PORT=7899"

echo.
echo ========================================
echo   claude-peers — team setup
echo ========================================
echo.

REM 1. Bun
where bun >nul 2>&1
if %errorlevel% neq 0 (
    echo Installing bun...
    where npm >nul 2>&1
    if %errorlevel% neq 0 (
        echo [error] npm not found. Install Node.js first.
        exit /b 1
    )
    call npm install -g bun
)
for /f "tokens=*" %%v in ('bun --version 2^>nul') do echo [ok] bun %%v

REM 2. Clone/update
if exist "%INSTALL_DIR%\.git" (
    cd /d "%INSTALL_DIR%"
    git pull --ff-only origin main 2>nul
) else (
    git clone "%REPO_URL%" "%INSTALL_DIR%"
)
cd /d "%INSTALL_DIR%"
call bun install
echo [ok] repo ready

REM 3. Claude Code
where claude >nul 2>&1
if %errorlevel% neq 0 (
    echo [error] Claude Code CLI not found.
    echo   Install: https://docs.anthropic.com/en/docs/claude-code
    exit /b 1
)
echo [ok] claude found

REM 4. Register MCP
claude mcp remove --scope user claude-peers 2>nul
claude mcp add --scope user --transport stdio claude-peers -- bun "%INSTALL_DIR%\server.ts"
echo [ok] MCP server registered

REM 5. Set env vars permanently
setx CLAUDE_PEERS_HOST "%BROKER_HOST%" >nul 2>&1
setx CLAUDE_PEERS_PORT "%BROKER_PORT%" >nul 2>&1
echo [ok] env vars set

REM 6. Create launch script in user PATH
set "LAUNCH_DIR=%USERPROFILE%\AppData\Local\Microsoft\WindowsApps"
(
    echo @echo off
    echo set "CLAUDE_PEERS_HOST=%BROKER_HOST%"
    echo set "CLAUDE_PEERS_PORT=%BROKER_PORT%"
    echo claude --dangerously-skip-permissions --dangerously-load-development-channels server:claude-peers %%*
) > "%LAUNCH_DIR%\claude-peers.cmd"
echo [ok] "claude-peers" command created

REM 7. Test broker
echo.
echo Testing broker connection...
curl -s --connect-timeout 3 "http://%BROKER_HOST%:%BROKER_PORT%/health" >nul 2>&1
if %errorlevel%==0 (
    echo [ok] Broker is reachable!
) else (
    echo [warn] Broker not reachable right now. Will connect when it's running.
)

echo.
echo ========================================
echo   Done! You're all set.
echo ========================================
echo.
echo   Open a NEW terminal, then run:
echo.
echo     claude-peers
echo.
echo   That's it. You're in the shared workspace.
echo.

endlocal
