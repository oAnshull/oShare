param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$LogoPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$logo = Get-Item -LiteralPath $LogoPath -ErrorAction Stop
if ($logo.Extension -ne ".png") { throw "The logo must be a square PNG file." }

$root = Split-Path -Parent $PSScriptRoot
$destinations = @(
  (Join-Path $root "server\src\brand-logo.png"),
  (Join-Path $root "android\app\src\main\res\drawable-nodpi\brand_logo.png")
)
foreach ($destination in $destinations) {
  if ($logo.FullName -ne [IO.Path]::GetFullPath($destination)) {
    Copy-Item -LiteralPath $logo.FullName -Destination $destination -Force
  }
}

Add-Type -AssemblyName System.Drawing
$source = [Drawing.Image]::FromFile($logo.FullName)
$bitmap = New-Object Drawing.Bitmap 64, 64
$graphics = [Drawing.Graphics]::FromImage($bitmap)
$graphics.DrawImage($source, 0, 0, 64, 64)
$icon = [Drawing.Icon]::FromHandle($bitmap.GetHicon())
$stream = [IO.File]::Create((Join-Path $root "desktop\brand-logo.ico"))
try {
  $icon.Save($stream)
} finally {
  $stream.Dispose()
  $icon.Dispose()
  $graphics.Dispose()
  $bitmap.Dispose()
  $source.Dispose()
}

Write-Host "Updated the web, Android, and Windows logo assets. Rebuild or reinstall each client to apply it."
