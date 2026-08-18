param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$LogoPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$logo = Get-Item -LiteralPath $LogoPath -ErrorAction Stop
if ($logo.Extension -ne ".png") { throw "The logo must be a square PNG file." }

$root = Split-Path -Parent $PSScriptRoot
Copy-Item -LiteralPath $logo.FullName -Destination (Join-Path $root "server\src\brand-logo.png") -Force
Copy-Item -LiteralPath $logo.FullName -Destination (Join-Path $root "android\app\src\main\res\drawable-nodpi\brand_logo.png") -Force

Write-Host "Updated the web and Android logo assets. Rebuild both clients to apply it."
