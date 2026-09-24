@echo off
setlocal
cd /d "%~dp0"
echo ========================================
echo BTC Local Lab Collector Status
echo ========================================
echo.
schtasks.exe /Query /TN "BTC-Local-Lab-DerivativesCollector" /FO LIST /V
echo.
echo ---------- Local collector status ----------
if exist "%~dp0data\collector-status.json" (
  powershell.exe -NoProfile -Command "Get-Content -Raw -LiteralPath '%~dp0data\collector-status.json'"
) else (
  echo No collector-status.json yet.
)
echo.
echo ---------- Recent log ----------
if exist "%~dp0data\collector.log" (
  powershell.exe -NoProfile -Command "Get-Content -LiteralPath '%~dp0data\collector.log' -Tail 12"
) else (
  echo No collector.log yet.
)
echo.
pause
