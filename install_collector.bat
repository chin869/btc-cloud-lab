@echo off
setlocal
cd /d "%~dp0"
echo.
echo ========================================
echo BTC Local Lab - Background Collector
echo ========================================
echo.
echo 1. Running an initial data collection...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0collector.ps1"
if errorlevel 1 (
  echo.
  echo Initial collection failed. The scheduled task will still be installed and retry hourly.
)

echo.
echo 2. Installing hourly Windows Scheduled Task...
schtasks.exe /Create /TN "BTC-Local-Lab-DerivativesCollector" /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0collector.ps1"" /SC HOURLY /MO 1 /F
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0configure_collector_task.ps1" >nul 2>&1
if errorlevel 1 (
  echo.
  echo Failed to create the scheduled task.
  echo Try right-clicking this file and choosing "Run as administrator".
  pause
  exit /b 1
)

echo.
echo 3. Starting the task once now...
schtasks.exe /Run /TN "BTC-Local-Lab-DerivativesCollector" >nul 2>&1

echo.
echo Installed successfully.
echo The collector will run once per hour while Windows can run scheduled tasks.
echo Data folder: %~dp0data
echo.
pause
