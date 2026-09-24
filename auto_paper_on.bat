@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$p='%~dp0data\auto-paper-settings.json';$x=Get-Content -Raw $p|ConvertFrom-Json;$x.enabled=$true;$x|ConvertTo-Json -Depth 5|Set-Content -Encoding UTF8 $p"
echo AUTO PAPER is ON.
schtasks.exe /Run /TN "BTC-Local-Lab-DerivativesCollector" >nul 2>&1
pause
