param([int]$Port=8080)
$ErrorActionPreference="Stop"
$Root=$PSScriptRoot
$CRLF=[Environment]::NewLine

function Get-Mime([string]$Path){
  switch ([IO.Path]::GetExtension($Path).ToLowerInvariant()) {
    ".html" { "text/html; charset=utf-8" }
    ".htm"  { "text/html; charset=utf-8" }
    ".js"   { "application/javascript; charset=utf-8" }
    ".css"  { "text/css; charset=utf-8" }
    ".json" { "application/json; charset=utf-8" }
    ".png"  { "image/png" }
    ".jpg"  { "image/jpeg" }
    ".jpeg" { "image/jpeg" }
    ".svg"  { "image/svg+xml" }
    ".ico"  { "image/x-icon" }
    default { "application/octet-stream" }
  }
}

function Write-Response($Stream,[string]$Status,[string]$Type,[byte[]]$Body){
  $header="HTTP/1.1 "+$Status+$CRLF+"Content-Type: "+$Type+$CRLF+"Cache-Control: no-store"+$CRLF+"Content-Length: "+$Body.Length+$CRLF+"Connection: close"+$CRLF+$CRLF
  $hb=[Text.Encoding]::ASCII.GetBytes($header)
  $Stream.Write($hb,0,$hb.Length)
  if($Body.Length -gt 0){$Stream.Write($Body,0,$Body.Length)}
}

$listener=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any,$Port)
$listener.Start()

try{
  $ips=@(Get-NetIPConfiguration |
    Where-Object { $_.IPv4DefaultGateway -and $_.IPv4Address } |
    ForEach-Object { $_.IPv4Address.IPAddress } |
    Where-Object { $_ -and $_ -notlike "169.254.*" })
  $ip=$ips | Where-Object { $_ -like "192.168.*" } | Select-Object -First 1
  if(-not $ip){$ip=$ips | Where-Object { $_ -like "10.*" } | Select-Object -First 1}
  if(-not $ip){$ip=$ips | Where-Object { $_ -match "^172\.(1[6-9]|2[0-9]|3[01])\." } | Select-Object -First 1}
  if(-not $ip){$ip=$ips | Select-Object -First 1}
}catch{$ip=$null}
if(-not $ip){$ip="YOUR-PC-IP"}

Clear-Host
Write-Host ""
Write-Host "BTC Local Lab - LAN Viewer" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor DarkGray
Write-Host "Keep this window OPEN while viewing from iPad." -ForegroundColor Yellow
Write-Host ""
Write-Host "On iPad Safari, open:" -ForegroundColor White
Write-Host ("http://{0}:{1}" -f $ip,$Port) -ForegroundColor Green
Write-Host ""
Write-Host "Press Ctrl+C here to stop the LAN viewer." -ForegroundColor DarkGray
Write-Host ""

while($true){
  $client=$listener.AcceptTcpClient()
  $stream=$null
  try{
    $stream=$client.GetStream()
    $reader=New-Object System.IO.StreamReader($stream,[Text.Encoding]::ASCII,$false,8192,$true)
    $requestLine=$reader.ReadLine()
    if([string]::IsNullOrWhiteSpace($requestLine)){continue}
    while($true){$line=$reader.ReadLine();if([string]::IsNullOrEmpty($line)){break}}

    $parts=$requestLine.Split(" ")
    $method=$parts[0]
    $rawPath=if($parts.Count -gt 1){$parts[1]}else{"/"}
    if($method -ne "GET"){
      Write-Response $stream "405 Method Not Allowed" "text/plain; charset=utf-8" ([Text.Encoding]::UTF8.GetBytes("Method Not Allowed"))
      continue
    }

    $pathOnly=$rawPath.Split("?")[0]
    $decoded=[Uri]::UnescapeDataString($pathOnly)
    if($decoded -eq "/"){$decoded="/index.html"}
    $relative=$decoded.TrimStart("/").Replace("/",[IO.Path]::DirectorySeparatorChar)
    $candidate=[IO.Path]::GetFullPath((Join-Path $Root $relative))
    $rootFull=[IO.Path]::GetFullPath($Root)

    if(-not $candidate.StartsWith($rootFull,[StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)){
      Write-Response $stream "404 Not Found" "text/plain; charset=utf-8" ([Text.Encoding]::UTF8.GetBytes("Not Found"))
      continue
    }

    $bytes=[IO.File]::ReadAllBytes($candidate)
    Write-Response $stream "200 OK" (Get-Mime $candidate) $bytes
  }catch{
  }finally{
    if($stream){$stream.Dispose()}
    $client.Close()
  }
}