param(
  [Parameter(Mandatory = $true)]
  [string]$ApiBaseUrl,

  [Parameter(Mandatory = $true)]
  [string]$UploadSecret,

  [string]$AppName = "oShare",

  [string]$MenuLabel = "Upload to cloud",

  [string]$IconPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$configPath = Join-Path $PSScriptRoot "config.json"
@{
  apiBaseUrl = $ApiBaseUrl.TrimEnd('/')
  uploadSecret = $UploadSecret
  appName = $AppName
} | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8

$powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$wscript = Join-Path $env:SystemRoot "System32\wscript.exe"
$launcherPath = Join-Path $PSScriptRoot "UploadToCloud.vbs"
$command = "`"$wscript`" `"$launcherPath`" `"%1`""

$registryPath = "Software\Classes\*\shell\oShareUpload"
$menuRegistryKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($registryPath)
try {
  $menuRegistryKey.SetValue("", $MenuLabel)
  $icon = if ($IconPath) { (Resolve-Path -LiteralPath $IconPath).Path } else { "$powershell,0" }
  $menuRegistryKey.SetValue("Icon", $icon)
} finally {
  $menuRegistryKey.Dispose()
}

$commandRegistryKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("$registryPath\command")
try {
  $commandRegistryKey.SetValue("", $command)
} finally {
  $commandRegistryKey.Dispose()
}

Write-Host "Installed '$MenuLabel' in the Windows file context menu."
Write-Host "Config written to $configPath"
