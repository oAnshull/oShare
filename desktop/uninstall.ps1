Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$menuKey = "HKCU:\Software\Classes\*\shell\oShareUpload"
if (Test-Path -LiteralPath $menuKey) {
  Remove-Item -LiteralPath $menuKey -Recurse -Force
  Write-Host "Removed 'Upload to cloud' from the Windows file context menu."
}
else {
  Write-Host "The 'Upload to cloud' context-menu entry was not installed."
}
