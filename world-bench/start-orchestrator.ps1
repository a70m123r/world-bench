# World-Bench Orchestrator — Startup Script
# Run: powershell -ExecutionPolicy Bypass -File start-orchestrator.ps1
# Or: double-click start-orchestrator.cmd (preferred — has restart loop)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

# Kill stale orchestrator processes (prevent split-brain / dual-dispatch)
# Same fix as Veil bridge: SYSTEM-STATE-2026-03-27 split-brain issue
Write-Host "[Orchestrator] Killing stale processes..."
Get-WmiObject Win32_Process | Where-Object { $_.CommandLine -like "*orchestrator/index.ts*" } | ForEach-Object {
    Write-Host "[Orchestrator] Killing PID $($_.ProcessId)"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2

# Clear inherited env vars — dotenv does NOT override existing env vars
# Pattern from start-soren.cmd
$env:ANTHROPIC_API_KEY = $null
$env:ANTHROPIC_AUTH_TOKEN = $null
$env:SLACK_BOT_TOKEN = $null
$env:SLACK_APP_TOKEN = $null
$env:CLAUDE_CODE_OAUTH_TOKEN = $null
Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue

Write-Host "[Orchestrator] Starting World-Bench Orchestrator..."
npx tsx orchestrator/index.ts
