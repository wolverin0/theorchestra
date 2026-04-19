@echo off
REM start-telegram-streamer.cmd
REM Launches the Telegram streamer (src/telegram-streamer.cjs) as a detached
REM background Node.js process. Idempotent — if a streamer is already running
REM this script does nothing. Designed to be registered as a Windows Scheduled
REM Task at user logon so the feed survives wezterm crashes and reboots.
REM
REM Logs land at %WEZBRIDGE_DIR%\logs\streamer.log (appended).

setlocal
set "WEZBRIDGE_DIR=G:\_OneDrive\OneDrive\Desktop\Py Apps\wezbridge"
set "STREAMER=%WEZBRIDGE_DIR%\src\telegram-streamer.cjs"
set "LOGDIR=%WEZBRIDGE_DIR%\logs"
set "LOG=%LOGDIR%\streamer.log"

if not exist "%LOGDIR%" mkdir "%LOGDIR%"

REM Idempotency check: is a streamer already running?
for /f "tokens=*" %%p in ('wmic process where "Name='node.exe' and CommandLine like '%%telegram-streamer.cjs%%'" get ProcessId /format:value 2^>nul ^| findstr /r "[0-9]"') do (
    echo %DATE% %TIME% [start-telegram-streamer] already running: %%p >> "%LOG%"
    exit /b 0
)

echo %DATE% %TIME% [start-telegram-streamer] launching node "%STREAMER%" >> "%LOG%"

REM `start /B` detaches. `"" ""` are the (empty) window title arg and program.
REM We use `node` from PATH which should be fine at logon time.
start /B "" node "%STREAMER%" >> "%LOG%" 2>&1

exit /b 0
