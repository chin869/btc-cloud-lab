@echo off
setlocal
echo Removing BTC Local Lab background collector...
schtasks.exe /Delete /TN "BTC-Local-Lab-DerivativesCollector" /F
echo.
echo Scheduled task removed.
echo Existing collected data was NOT deleted.
pause
