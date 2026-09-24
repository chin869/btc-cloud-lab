$ErrorActionPreference = "Stop"
$TaskName = "BTC-Local-Lab-DerivativesCollector"
$task = Get-ScheduledTask -TaskName $TaskName
$settings = $task.Settings
$settings.DisallowStartIfOnBatteries = $false
$settings.StopIfGoingOnBatteries = $false
$settings.StartWhenAvailable = $true
$settings.ExecutionTimeLimit = "PT30M"
Set-ScheduledTask -TaskName $TaskName -Settings $settings | Out-Null
Write-Output "Task settings updated."
