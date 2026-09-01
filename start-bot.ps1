# zcode-claim-bot - auto-start wrapper
# Install task:
#   schtasks /Create /F /TN "ZCodeClaimBot" /SC ONLOGON /RL HIGHEST /TR "\"powershell.exe\" -NoProfile -ExecutionPolicy Bypass -File \"%~dp0start-bot.ps1\""
# Run now: powershell -NoProfile -ExecutionPolicy Bypass -File start-bot.ps1

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$env:NODE_NO_WARNINGS = '1'
Set-Location $here
node src\index.mjs
