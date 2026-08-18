param(
  [Parameter(Mandatory = $true)]
  [string]$ApiBaseUrl,

  [string]$AppName = "oShare",

  [string]$MenuLabel = "Upload to cloud",

  [string]$IconPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security

$configPath = Join-Path $PSScriptRoot "config.json"
$existingConfig = if (Test-Path -LiteralPath $configPath) {
  Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
}
$existingProperties = if ($existingConfig) { $existingConfig.PSObject.Properties.Name } else { @() }

if ($existingProperties -contains "uploadSecretProtected" -and $existingConfig.uploadSecretProtected) {
  $secretBytes = [Security.Cryptography.ProtectedData]::Unprotect(
    [Convert]::FromBase64String($existingConfig.uploadSecretProtected),
    $null,
    [Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  $secretText = [Text.Encoding]::UTF8.GetString($secretBytes)
} elseif ($existingProperties -contains "uploadSecret" -and $existingConfig.uploadSecret) {
  $secretText = [string]$existingConfig.uploadSecret
} else {
  $uploadSecret = Read-Host "Uploader secret" -AsSecureString
  $secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($uploadSecret)
  try {
    $secretText = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer)
  }
}

if ($secretText.Length -lt 16) { throw "Uploader secret must be at least 16 characters." }
$secretBytes = [Text.Encoding]::UTF8.GetBytes($secretText)
$protectedSecret = [Convert]::ToBase64String(
  [Security.Cryptography.ProtectedData]::Protect($secretBytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
)

@{
  apiBaseUrl = $ApiBaseUrl.TrimEnd('/')
  uploadSecretProtected = $protectedSecret
  appName = $AppName
} | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8

$wscript = Join-Path $env:SystemRoot "System32\wscript.exe"
$launcherPath = Join-Path $PSScriptRoot "UploadToCloud.vbs"
$command = "`"$wscript`" `"$launcherPath`" `"%1`""

$registryPath = "Software\Classes\*\shell\oShareUpload"
$menuRegistryKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($registryPath)
try {
  $menuRegistryKey.SetValue("", $MenuLabel)
  $icon = if ($IconPath) { (Resolve-Path -LiteralPath $IconPath).Path } else { Join-Path $PSScriptRoot "brand-logo.ico" }
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
