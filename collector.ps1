$ErrorActionPreference = "Stop"

$Root = $PSScriptRoot
$DataDir = Join-Path $Root "data"
$JsonPath = Join-Path $DataDir "derivatives-history.json"
$JsPath = Join-Path $DataDir "derivatives-history.js"
$StatusPath = Join-Path $DataDir "collector-status.json"
$LogPath = Join-Path $DataDir "collector.log"
$Base = "https://fapi.binance.com"
$MaxRowsPerFeed = 30000

if (-not (Test-Path $DataDir)) {
    New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
}

function Write-Log {
    param([string]$Message)
    $line = ("{0} {1}" -f (Get-Date).ToString("s"), $Message)
    Add-Content -Path $LogPath -Value $line -Encoding UTF8
}

function Write-AtomicText {
    param([string]$Path, [string]$Content)
    $tmp = "$Path.tmp"
    Set-Content -Path $tmp -Value $Content -Encoding UTF8
    Move-Item -Path $tmp -Destination $Path -Force
}

function Invoke-BinanceJson {
    param([string]$Uri)
    Invoke-RestMethod -Uri $Uri -Method Get -TimeoutSec 20 -Headers @{"User-Agent"="BTC-Local-Lab/1.0"}
}

function Get-PagedRows {
    param(
        [string]$Endpoint,
        [string]$ExtraQuery,
        [long]$StartMs,
        [long]$EndMs,
        [int]$Limit,
        [string]$TimestampField
    )

    $all = @()
    $cursor = $StartMs
    $pages = 0
    while ($cursor -le $EndMs -and $pages -lt 20) {
        $uri = "${Base}${Endpoint}?symbol=BTCUSDT&${ExtraQuery}&startTime=${cursor}&endTime=${EndMs}&limit=${Limit}"
        $rawRows = Invoke-BinanceJson -Uri $uri
        $rows = @()
        foreach ($item in $rawRows) { $rows += $item }
        if ($rows.Count -eq 0) { break }

        foreach ($row in $rows) {
            $tsValue = $row.$TimestampField
            if ($tsValue -is [System.Array]) { $tsValue = $tsValue[-1] }
            $ts = [long]$tsValue
            if ($TimestampField -eq "fundingTime") {
                $row | Add-Member -NotePropertyName timestamp -NotePropertyValue $ts -Force
            }
            $all += $row
        }

        $lastValue = $rows[-1].$TimestampField
        if ($lastValue -is [System.Array]) { $lastValue = $lastValue[-1] }
        $lastTs = [long]$lastValue
        if ($lastTs -le $cursor) { break }
        $cursor = $lastTs + 1
        $pages++
        if ($rows.Count -lt $Limit) { break }
        Start-Sleep -Milliseconds 120
    }
    return @($all)
}

function Merge-Rows {
    param([object[]]$Existing, [object[]]$Incoming)

    $map = @{}
    foreach ($row in @($Existing) + @($Incoming)) {
        if ($null -eq $row) { continue }
        $tsValue = $row.timestamp
        if ($tsValue -is [System.Array]) { $tsValue = $tsValue[-1] }
        $ts = [long]$tsValue
        if ($ts -le 0) { continue }
        $map[$ts.ToString()] = $row
    }

    $rows = @($map.Values | Sort-Object { [long]$_.timestamp })
    if ($rows.Count -gt $MaxRowsPerFeed) {
        $rows = @($rows | Select-Object -Last $MaxRowsPerFeed)
    }
    return @($rows)
}

function Load-Existing {
    if (-not (Test-Path $JsonPath)) {
        return @{
            version = 1
            updatedAt = $null
            feeds = @{
                funding = @()
                openInterest = @()
                longShort = @()
                taker = @()
            }
        }
    }

    try {
        $raw = Get-Content -Raw -Path $JsonPath -Encoding UTF8 | ConvertFrom-Json
        return @{
            version = 1
            updatedAt = $raw.updatedAt
            feeds = @{
                funding = @($raw.feeds.funding)
                openInterest = @($raw.feeds.openInterest)
                longShort = @($raw.feeds.longShort)
                taker = @($raw.feeds.taker)
            }
        }
    } catch {
        Write-Log "Existing JSON unreadable; preserving file and starting in-memory empty: $($_.Exception.Message)"
        return @{
            version = 1
            updatedAt = $null
            feeds = @{
                funding = @()
                openInterest = @()
                longShort = @()
                taker = @()
            }
        }
    }
}

$attemptAt = (Get-Date).ToUniversalTime().ToString("o")
$status = @{
    version = 1
    lastAttemptAt = $attemptAt
    lastSuccessAt = $null
    lastError = $null
    counts = @{}
}

try {
    $existing = Load-Existing
    $now = [DateTimeOffset]::UtcNow
    $endMs = $now.ToUnixTimeMilliseconds()

    $hasHistory = (@($existing.feeds.openInterest).Count -ge 400)
    if ($hasHistory) {
        $derivativeStartMs = $now.AddDays(-29).ToUnixTimeMilliseconds()
        $fundingStartMs = $now.AddDays(-14).ToUnixTimeMilliseconds()
        Write-Log "Incremental collection started."
    } else {
        $derivativeStartMs = $now.AddDays(-29).ToUnixTimeMilliseconds()
        $fundingStartMs = $now.AddDays(-365).ToUnixTimeMilliseconds()
        Write-Log "Bootstrap collection started."
    }

    $fundingResponse = Invoke-BinanceJson -Uri "${Base}/fapi/v1/fundingRate?symbol=BTCUSDT&limit=1000"
    $fundingRaw = @()
    foreach ($item in $fundingResponse) { $fundingRaw += $item }
    $funding = @()
    foreach ($row in $fundingRaw) {
        $tsValue = $row.fundingTime
        if ($tsValue -is [System.Array]) { $tsValue = $tsValue[-1] }
        $ts = [long]$tsValue
        $row | Add-Member -NotePropertyName timestamp -NotePropertyValue $ts -Force
        $funding += $row
    }
    $openInterest = @(Get-PagedRows -Endpoint "/futures/data/openInterestHist" -ExtraQuery "period=1h" -StartMs $derivativeStartMs -EndMs $endMs -Limit 500 -TimestampField "timestamp")
    $longShort = @(Get-PagedRows -Endpoint "/futures/data/globalLongShortAccountRatio" -ExtraQuery "period=1h" -StartMs $derivativeStartMs -EndMs $endMs -Limit 500 -TimestampField "timestamp")
    $taker = @(Get-PagedRows -Endpoint "/futures/data/takerlongshortRatio" -ExtraQuery "period=1h" -StartMs $derivativeStartMs -EndMs $endMs -Limit 500 -TimestampField "timestamp")

    $merged = @{
        version = 1
        updatedAt = (Get-Date).ToUniversalTime().ToString("o")
        feeds = @{
            funding = @(Merge-Rows -Existing @($existing.feeds.funding) -Incoming $funding)
            openInterest = @(Merge-Rows -Existing @($existing.feeds.openInterest) -Incoming $openInterest)
            longShort = @(Merge-Rows -Existing @($existing.feeds.longShort) -Incoming $longShort)
            taker = @(Merge-Rows -Existing @($existing.feeds.taker) -Incoming $taker)
        }
    }

    $status.lastSuccessAt = $merged.updatedAt
    $status.counts = @{
        funding = @($merged.feeds.funding).Count
        openInterest = @($merged.feeds.openInterest).Count
        longShort = @($merged.feeds.longShort).Count
        taker = @($merged.feeds.taker).Count
    }

    $json = $merged | ConvertTo-Json -Depth 8 -Compress
    Write-AtomicText -Path $JsonPath -Content $json

    $browserPayload = @{
        version = $merged.version
        updatedAt = $merged.updatedAt
        feeds = $merged.feeds
        collector = $status
    }
    $browserJson = $browserPayload | ConvertTo-Json -Depth 8 -Compress
    Write-AtomicText -Path $JsPath -Content ("window.BTCLocalDerivativesHistory = " + $browserJson + ";")

    Write-AtomicText -Path $StatusPath -Content ($status | ConvertTo-Json -Depth 6)
    Write-Log ("Success: funding={0}, oi={1}, longShort={2}, taker={3}" -f $status.counts.funding, $status.counts.openInterest, $status.counts.longShort, $status.counts.taker)
    $autoScript = Join-Path $Root "auto_paper.ps1"
    if (Test-Path $autoScript) {
        $autoRunnerOut = Join-Path $DataDir "auto-paper-runner.out.log"
        $autoRunnerErr = Join-Path $DataDir "auto-paper-runner.err.log"
        $proc = Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile","-ExecutionPolicy","Bypass","-File",$autoScript) -Wait -PassThru -RedirectStandardOutput $autoRunnerOut -RedirectStandardError $autoRunnerErr
        $autoUtf8 = Join-Path $DataDir "auto-paper-runner-utf8.log"
        $combined = ""
        if (Test-Path $autoRunnerOut) { $combined += (Get-Content -Raw -Path $autoRunnerOut -ErrorAction SilentlyContinue) }
        if (Test-Path $autoRunnerErr) { $combined += (Get-Content -Raw -Path $autoRunnerErr -ErrorAction SilentlyContinue) }
        Set-Content -Path $autoUtf8 -Value $combined -Encoding UTF8
        if ($proc.ExitCode -eq 0) {
            Write-Log "AUTO PAPER cycle completed."
        } else {
            Write-Log ("AUTO PAPER cycle failed with exit code " + $proc.ExitCode)
        }
    }

    exit 0
}
catch {
    $status.lastError = $_.Exception.Message
    if (Test-Path $StatusPath) {
        try {
            $oldStatus = Get-Content -Raw -Path $StatusPath -Encoding UTF8 | ConvertFrom-Json
            $status.lastSuccessAt = $oldStatus.lastSuccessAt
            $status.counts = $oldStatus.counts
        } catch {}
    }
    Write-AtomicText -Path $StatusPath -Content ($status | ConvertTo-Json -Depth 6)
    Write-Log ("ERROR: " + $_.Exception.Message)
    Write-Log ("STACK: " + $_.ScriptStackTrace)
    exit 1
}
