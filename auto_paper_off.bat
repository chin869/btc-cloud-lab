@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$p='%~dp0data\auto-paper-settings.json';$x=Get-Content -Raw $p|ConvertFrom-Json;$x.enabled=$false;$x|ConvertTo-Json -Depth 5|Set-Content -Encoding UTF8 $p"
echo AUTO PAPER is OFF. Existing paper positions and history were NOT deleted.
pause
