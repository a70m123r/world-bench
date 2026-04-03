@echo off
title World-Bench Orchestrator v0.4
cd /d D:\OpenClawWorkspace\world-bench

:: Kill any existing orchestrator process to prevent split-brain.
:: Same fix as Veil bridge (SYSTEM-STATE-2026-03-27: split-brain issue).
echo [%date% %time%] Killing stale orchestrator processes...
for /f "tokens=2" %%i in ('wmic process where "commandline like '%%orchestrator/index.ts%%'" get processid 2^>nul ^| findstr /r "[0-9]"') do taskkill /f /pid %%i >nul 2>&1

:: Clear inherited env vars to prevent contamination from parent shell.
:: Pattern from start-soren.cmd — dotenv does NOT override existing env vars.
set ANTHROPIC_API_KEY=
set ANTHROPIC_AUTH_TOKEN=
set SLACK_BOT_TOKEN=
set SLACK_APP_TOKEN=
set CLAUDE_CODE_OAUTH_TOKEN=

:orchestrator_loop
echo [%date% %time%] Starting World-Bench Orchestrator...
call npx tsx orchestrator/index.ts
echo [%date% %time%] Orchestrator exited, restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto orchestrator_loop
