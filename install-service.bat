@echo off
REM ============================================================
REM Install claude-peers broker as a Windows scheduled task
REM that auto-starts on logon.
REM
REM Run as: install-service.bat [--secret mysecret]
REM Remove: install-service.bat --remove
REM ============================================================

setlocal enabledelayedexpansion

set "TASK_NAME=Claude-Peers-Broker"
set "INSTALL_DIR=%~dp0"
set "SHARED_SECRET="
set "REMOVE=false"

REM Parse args
:parse
if "%~1"=="" goto start
if "%~1"=="--secret" (set "SHARED_SECRET=%~2" & shift & shift & goto parse)
if "%~1"=="--remove" (set "REMOVE=true" & shift & goto parse)
shift
goto parse

:start

if "%REMOVE%"=="true" (
    echo Removing scheduled task %TASK_NAME%...
    schtasks /Delete /TN "%TASK_NAME%" /F 2>nul
    if %errorlevel%==0 (
        echo [ok] Task removed.
    ) else (
        echo [warn] Task not found or already removed.
    )
    REM Also kill any running broker
    for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":7899" ^| findstr "LISTENING" 2^>nul') do (
        taskkill /F /PID %%p 2>nul
    )
    echo [ok] Broker stopped.
    goto :eof
)

REM Find bun path
where bun >nul 2>&1
if %errorlevel% neq 0 (
    echo [error] bun not found. Install it first: npm install -g bun
    exit /b 1
)
for /f "tokens=*" %%b in ('where bun') do set "BUN_PATH=%%b"

REM Create the launcher VBS (hidden window — no popup)
set "VBS_PATH=%INSTALL_DIR%broker-launcher.vbs"
echo Creating hidden launcher at %VBS_PATH%...

(
    echo Set objShell = CreateObject^("WScript.Shell"^)
    echo objShell.Environment^("Process"^).Item^("CLAUDE_PEERS_BIND"^) = "lan"
    if not "%SHARED_SECRET%"=="" (
        echo objShell.Environment^("Process"^).Item^("CLAUDE_PEERS_SECRET"^) = "%SHARED_SECRET%"
    )
    echo objShell.Run """!BUN_PATH!"" ""!INSTALL_DIR!broker.ts""", 0, False
) > "%VBS_PATH%"

echo [ok] Launcher script created

REM Remove existing task if any
schtasks /Delete /TN "%TASK_NAME%" /F 2>nul

REM Create scheduled task — runs on any user logon
schtasks /Create /TN "%TASK_NAME%" /TR "wscript.exe \"%VBS_PATH%\"" /SC ONLOGON /RL HIGHEST /F
if %errorlevel%==0 (
    echo [ok] Scheduled task "%TASK_NAME%" created (runs on logon^)
) else (
    echo [error] Failed to create scheduled task. Try running as Administrator.
    exit /b 1
)

REM Start it now
echo [info] Starting broker now...
wscript.exe "%VBS_PATH%"
timeout /t 2 /nobreak >nul

REM Verify
curl -s --connect-timeout 3 http://127.0.0.1:7899/health >nul 2>&1
if %errorlevel%==0 (
    echo [ok] Broker is running!
    for /f "tokens=*" %%h in ('curl -s http://127.0.0.1:7899/health') do echo     %%h
) else (
    echo [warn] Broker may still be starting. Check with:
    echo     bun "%INSTALL_DIR%cli.ts" status
)

echo.
echo ============================================
echo   Broker service installed!
echo ============================================
echo.
echo   The broker will auto-start on logon.
echo.
echo   Manage:
echo     install-service.bat --remove    Remove the service
echo     bun "%INSTALL_DIR%cli.ts" status   Check status
echo     bun "%INSTALL_DIR%cli.ts" kill-broker   Stop manually
echo.

endlocal
