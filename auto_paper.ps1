param([switch]$SelfTest)
$ErrorActionPreference="Stop"
$Root=$PSScriptRoot
$DataDir=Join-Path $Root "data"
$SettingsPath=Join-Path $DataDir "auto-paper-settings.json"
$LedgerPath=Join-Path $DataDir "auto-paper.json"
$JsPath=Join-Path $DataDir "auto-paper.js"
$LogPath=Join-Path $DataDir "auto-paper.log"
$EnginePath=Join-Path $Root "auto-engine.html"

if(-not(Test-Path $DataDir)){New-Item -ItemType Directory -Path $DataDir -Force|Out-Null}

function Write-AutoLog([string]$Message){
  Add-Content -Path $LogPath -Value ("{0} {1}" -f (Get-Date).ToString("s"),$Message) -Encoding UTF8
}
function Write-Atomic([string]$Path,[string]$Content){
  $tmp="$Path.tmp"
  Set-Content -Path $tmp -Value $Content -Encoding UTF8
  Move-Item -Path $tmp -Destination $Path -Force
}
function Default-Settings {
  [ordered]@{
    enabled=$true
    initialBalance=10000.0
    maxPositionPct=0.10
    feeRate=0.001
    slippageRate=0.0005
    stopLossPct=0.02
    takeProfitPct=0.04
    maxHoldHours=48
    experimentalTrading=$true
  }
}
function Save-Settings($settings){
  Write-Atomic $SettingsPath ($settings|ConvertTo-Json -Depth 6)
}
function Load-Settings {
  if(Test-Path $SettingsPath){
    try{return Get-Content -Raw -Path $SettingsPath -Encoding UTF8|ConvertFrom-Json}catch{}
  }
  $s=Default-Settings
  Save-Settings $s
  return Get-Content -Raw -Path $SettingsPath -Encoding UTF8|ConvertFrom-Json
}
function New-Ledger($settings){
  [ordered]@{
    version=1
    createdAt=(Get-Date).ToUniversalTime().ToString("o")
    updatedAt=$null
    lastRunAt=$null
    lastSuccessAt=$null
    lastError=$null
    lastProcessedCandleTs=0
    lastDecision=$null
    settingsSnapshot=$settings
    account=[ordered]@{
      cash=[double]$settings.initialBalance
      qty=0.0
      avgEntry=0.0
      realizedPnl=0.0
      positionOpenedAt=$null
      trades=@()
      equityHistory=@()
    }
  }
}
function Load-Ledger($settings){
  if(Test-Path $LedgerPath){
    try{return Get-Content -Raw -Path $LedgerPath -Encoding UTF8|ConvertFrom-Json}catch{}
  }
  return New-Ledger $settings
}
function Save-Ledger($ledger){
  $ledger.updatedAt=(Get-Date).ToUniversalTime().ToString("o")
  $json=$ledger|ConvertTo-Json -Depth 12 -Compress
  Write-Atomic $LedgerPath $json
  Write-Atomic $JsPath ("window.BTCAutoPaper = "+$json+";")
}
function Find-Browser {
  $paths=@(
    "C:\Program Files\Google\Chrome\Application\chrome.exe",
    "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
  )
  foreach($path in $paths){if(Test-Path $path){return $path}}
  throw "Chrome or Edge not found"
}
function Get-EngineDecision {
  $browser=Find-Browser
  $uri=(New-Object System.Uri($EnginePath)).AbsoluteUri
  $args=@("--headless=new","--disable-gpu","--virtual-time-budget=40000","--dump-dom",$uri)
  $stdout=Join-Path $DataDir "auto-engine-dom.tmp"
  $stderr=Join-Path $DataDir "auto-engine-browser.tmp"
  $proc=Start-Process -FilePath $browser -ArgumentList $args -Wait -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  if($proc.ExitCode -ne 0){throw ("AUTO engine browser exit code "+$proc.ExitCode)}
  $dom=Get-Content -Raw -Path $stdout -Encoding UTF8
  $match=[regex]::Match($dom,"AUTO_RESULT_START(.*?)AUTO_RESULT_END",[System.Text.RegularExpressions.RegexOptions]::Singleline)
  if(-not $match.Success){throw "AUTO engine returned no result"}
  $json=[System.Net.WebUtility]::HtmlDecode($match.Groups[1].Value)
  return $json|ConvertFrom-Json
}
function Append-Trade($account,$trade){
  $old=@($account.trades)
  $account.trades=@(@($trade)+$old|Select-Object -First 500)
}
function Append-Equity($account,[long]$candleTs,[double]$price){
  $equity=[double]$account.cash+[double]$account.qty*$price
  $point=[ordered]@{ts=$candleTs;equity=$equity;price=$price}
  $old=@($account.equityHistory|Where-Object{[long]$_.ts -ne $candleTs})
  $account.equityHistory=@(@($point)+$old|Sort-Object {[long]$_.ts}|Select-Object -Last 5000)
}
function Run-SelfTest {
  $s=Default-Settings
  $ledger=New-Ledger $s
  $a=$ledger.account
  $price=100000.0
  $equity=[double]$a.cash
  $notional=[Math]::Min($equity*[double]$s.maxPositionPct,[double]$a.cash/(1+[double]$s.feeRate))
  $fill=$price*(1+[double]$s.slippageRate)
  $qty=$notional/$fill
  $fee=$notional*[double]$s.feeRate
  $a.cash=[double]$a.cash-$notional-$fee
  $a.qty=$qty
  $a.avgEntry=($notional+$fee)/$qty
  $sellFill=102000*(1-[double]$s.slippageRate)
  $gross=$qty*$sellFill
  $sellFee=$gross*[double]$s.feeRate
  $realized=($gross-$sellFee)-$qty*[double]$a.avgEntry
  if($realized -le 0){throw "SelfTest expected a positive result"}
  Write-Output ("SELFTEST_OK realized="+$realized.ToString("F2"))
}

if($SelfTest){Run-SelfTest;exit 0}

$settings=Load-Settings
$ledger=Load-Ledger $settings
$ledger.settingsSnapshot=$settings
$ledger.lastRunAt=(Get-Date).ToUniversalTime().ToString("o")

try{
  if(-not [bool]$settings.enabled){
    $ledger.lastDecision=[ordered]@{signal="DISABLED";mode="off";reason="AUTO PAPER disabled";at=$ledger.lastRunAt}
    Save-Ledger $ledger
    Write-AutoLog "Skipped: disabled."
    exit 0
  }

  $decision=Get-EngineDecision
  if(-not [bool]$decision.ok){throw ("Engine: "+$decision.error)}
  $price=[double]$decision.price
  $candleTs=[long]$decision.candleTs
  $account=$ledger.account

  if([long]$ledger.lastProcessedCandleTs -eq $candleTs){
    Append-Equity $account $candleTs $price
    $ledger.lastSuccessAt=(Get-Date).ToUniversalTime().ToString("o")
    $ledger.lastError=$null
    Save-Ledger $ledger
    Write-AutoLog ("No duplicate trade: candle "+$candleTs)
    exit 0
  }

  $signal=[string]$decision.signal
  $mode=[string]$decision.mode
  if($mode -eq "experimental-unvalidated" -and -not [bool]$settings.experimentalTrading){$signal="HOLD"}

  $qty=[double]$account.qty
  $cash=[double]$account.cash
  $action="HOLD"
  $reason=[string]$decision.reason

  if($qty -gt 0){
    $entry=[double]$account.avgEntry
    $heldHours=0.0
    if($account.positionOpenedAt){
      $heldHours=((Get-Date).ToUniversalTime() - [DateTime]::Parse([string]$account.positionOpenedAt).ToUniversalTime()).TotalHours
    }
    if($price -le $entry*(1-[double]$settings.stopLossPct)){
      $action="SELL";$reason="Risk stop loss "+([double]$settings.stopLossPct*100).ToString("F1")+"%"
    }elseif($price -ge $entry*(1+[double]$settings.takeProfitPct)){
      $action="SELL";$reason="Risk take profit "+([double]$settings.takeProfitPct*100).ToString("F1")+"%"
    }elseif($heldHours -ge [double]$settings.maxHoldHours){
      $action="SELL";$reason="Max holding time "+[string]$settings.maxHoldHours+" hours"
    }elseif($signal -eq "SELL"){
      $action="SELL"
    }
  }elseif($signal -eq "BUY"){
    $action="BUY"
  }

  if($action -eq "BUY"){
    $equity=$cash
    $notional=[Math]::Min($equity*[double]$settings.maxPositionPct,$cash/(1+[double]$settings.feeRate))
    if($notional -ge 10){
      $fill=$price*(1+[double]$settings.slippageRate)
      $buyQty=$notional/$fill
      $fee=$notional*[double]$settings.feeRate
      $account.cash=$cash-$notional-$fee
      $account.qty=$buyQty
      $account.avgEntry=($notional+$fee)/$buyQty
      $account.positionOpenedAt=(Get-Date).ToUniversalTime().ToString("o")
      $trade=[ordered]@{
        ts=(Get-Date).ToUniversalTime().ToString("o");candleTs=$candleTs;side="BUY";qty=$buyQty;fill=$fill;fee=$fee;realized=0.0;
        mode=$mode;source="AUTO";reason=$reason;probabilityUp=[double]$decision.probabilityUp;confidence=[double]$decision.confidence
      }
      Append-Trade $account $trade
      Write-AutoLog ("BUY qty={0} fill={1} mode={2}" -f $buyQty,$fill,$mode)
    }
  }elseif($action -eq "SELL" -and $qty -gt 0){
    $fill=$price*(1-[double]$settings.slippageRate)
    $gross=$qty*$fill
    $fee=$gross*[double]$settings.feeRate
    $proceeds=$gross-$fee
    $cost=$qty*[double]$account.avgEntry
    $realized=$proceeds-$cost
    $account.cash=$cash+$proceeds
    $account.qty=0.0
    $account.avgEntry=0.0
    $account.realizedPnl=[double]$account.realizedPnl+$realized
    $account.positionOpenedAt=$null
    $trade=[ordered]@{
      ts=(Get-Date).ToUniversalTime().ToString("o");candleTs=$candleTs;side="SELL";qty=$qty;fill=$fill;fee=$fee;realized=$realized;
      mode=$mode;source="AUTO";reason=$reason;probabilityUp=[double]$decision.probabilityUp;confidence=[double]$decision.confidence
    }
    Append-Trade $account $trade
    Write-AutoLog ("SELL qty={0} fill={1} pnl={2} mode={3}" -f $qty,$fill,$realized,$mode)
  }else{
    Write-AutoLog ("HOLD signal={0} mode={1} p={2}" -f $signal,$mode,[double]$decision.probabilityUp)
  }

  Append-Equity $account $candleTs $price
  $ledger.lastProcessedCandleTs=$candleTs
  $ledger.lastDecision=[ordered]@{
    at=(Get-Date).ToUniversalTime().ToString("o");candleTs=$candleTs;signal=$signal;executed=$action;mode=$mode;
    price=$price;probabilityUp=[double]$decision.probabilityUp;confidence=[double]$decision.confidence;reason=$reason
  }
  $ledger.lastSuccessAt=(Get-Date).ToUniversalTime().ToString("o")
  $ledger.lastError=$null
  Save-Ledger $ledger
}catch{
  $ledger.lastError=$_.Exception.Message
  Save-Ledger $ledger
  Write-AutoLog ("ERROR: "+$_.Exception.Message)
  exit 1
}
