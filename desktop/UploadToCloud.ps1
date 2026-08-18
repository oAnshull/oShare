param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$FilePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$appName = "oShare"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Security

Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Net;
using System.Threading;
using System.Threading.Tasks;

public sealed class OShareUpload
{
    public long BytesSent;
    public long TotalBytes;
    public volatile bool Complete;
    public volatile bool Cancelled;
    public string Error;
    private HttpWebRequest request;

    public void Start(string url, string path, string contentType)
    {
        TotalBytes = new FileInfo(path).Length;
        Task.Run(() => Run(url, path, contentType));
    }

    public void Cancel()
    {
        Cancelled = true;
        try { if (request != null) request.Abort(); } catch { }
    }

    private void Run(string url, string path, string contentType)
    {
        try
        {
            ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
            request = (HttpWebRequest)WebRequest.Create(url);
            request.Method = "PUT";
            request.ContentType = contentType;
            request.ContentLength = TotalBytes;
            request.AllowWriteStreamBuffering = false;
            request.SendChunked = false;
            request.Timeout = Timeout.Infinite;
            request.ReadWriteTimeout = 300000;

            byte[] buffer = new byte[1024 * 1024];
            using (FileStream input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, buffer.Length, FileOptions.SequentialScan))
            using (Stream output = request.GetRequestStream())
            {
                int read;
                while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
                {
                    if (Cancelled) throw new OperationCanceledException();
                    output.Write(buffer, 0, read);
                    Interlocked.Add(ref BytesSent, read);
                }
            }

            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            {
                int status = (int)response.StatusCode;
                if (status < 200 || status >= 300) throw new WebException("Storage returned HTTP " + status + ".");
            }
        }
        catch (OperationCanceledException) { Error = "Upload cancelled."; }
        catch (WebException ex) { Error = Cancelled ? "Upload cancelled." : ex.Message; }
        catch (Exception ex) { Error = ex.Message; }
        finally { Complete = true; }
    }
}
"@

function Format-Bytes([double]$Bytes) {
  $units = @("B", "KB", "MB", "GB", "TB")
  $index = 0
  while ($Bytes -ge 1024 -and $index -lt $units.Count - 1) { $Bytes /= 1024; $index++ }
  if ($index -eq 0) { return "{0:0} {1}" -f $Bytes, $units[$index] }
  return "{0:0.0} {1}" -f $Bytes, $units[$index]
}

function Format-Duration([double]$Seconds) {
  if ([double]::IsNaN($Seconds) -or [double]::IsInfinity($Seconds) -or $Seconds -lt 0) { return "--" }
  $span = [TimeSpan]::FromSeconds([Math]::Ceiling($Seconds))
  if ($span.TotalHours -ge 1) { return "{0}h {1}m" -f [Math]::Floor($span.TotalHours), $span.Minutes }
  if ($span.TotalMinutes -ge 1) { return "{0}m {1}s" -f $span.Minutes, $span.Seconds }
  return "{0}s" -f $span.Seconds
}

function Show-ExpiryDialog([string]$AppName) {
  $options = @(
    [pscustomobject]@{ Label = "1 hour"; Seconds = 3600 },
    [pscustomobject]@{ Label = "6 hours"; Seconds = 21600 },
    [pscustomobject]@{ Label = "1 day"; Seconds = 86400 },
    [pscustomobject]@{ Label = "3 days"; Seconds = 259200 },
    [pscustomobject]@{ Label = "7 days"; Seconds = 604800 }
  )

  $form = New-Object System.Windows.Forms.Form
  $form.Text = "Upload to $AppName"
  $form.StartPosition = "CenterScreen"
  $form.Size = New-Object System.Drawing.Size(360, 160)
  $form.MinimizeBox = $false
  $form.MaximizeBox = $false
  $form.TopMost = $true

  $label = New-Object System.Windows.Forms.Label
  $label.Text = "Keep this file available for:"
  $label.AutoSize = $true
  $label.Location = New-Object System.Drawing.Point(18, 18)
  $form.Controls.Add($label)

  $combo = New-Object System.Windows.Forms.ComboBox
  $combo.DropDownStyle = "DropDownList"
  $combo.Location = New-Object System.Drawing.Point(18, 45)
  $combo.Size = New-Object System.Drawing.Size(305, 24)
  foreach ($option in $options) { [void]$combo.Items.Add($option.Label) }
  $combo.SelectedIndex = 2
  $form.Controls.Add($combo)

  $ok = New-Object System.Windows.Forms.Button
  $ok.Text = "Upload"
  $ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
  $ok.Location = New-Object System.Drawing.Point(167, 82)
  $form.Controls.Add($ok)

  $cancel = New-Object System.Windows.Forms.Button
  $cancel.Text = "Cancel"
  $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
  $cancel.Location = New-Object System.Drawing.Point(248, 82)
  $form.Controls.Add($cancel)

  $form.AcceptButton = $ok
  $form.CancelButton = $cancel

  $result = $form.ShowDialog()
  if ($result -ne [System.Windows.Forms.DialogResult]::OK) { return $null }
  return $options[$combo.SelectedIndex].Seconds
}

function Get-ContentType([string]$Path) {
  $extension = [System.IO.Path]::GetExtension($Path).ToLowerInvariant()
  if ($extension) {
    $registryPath = "Registry::HKEY_CLASSES_ROOT\$extension"
    $contentType = (Get-ItemProperty -LiteralPath $registryPath -Name "Content Type" -ErrorAction SilentlyContinue)."Content Type"
    if ($contentType) { return $contentType }
  }
  return "application/octet-stream"
}

function Show-UploadProgress($File, [string]$UploadUrl, [string]$ContentType, [string]$AppName) {
  $form = New-Object System.Windows.Forms.Form
  $form.Text = "Uploading to $AppName"
  $form.StartPosition = "CenterScreen"
  $form.ClientSize = New-Object System.Drawing.Size(430, 180)
  $form.FormBorderStyle = "FixedDialog"
  $form.MaximizeBox = $false
  $form.MinimizeBox = $false
  $form.ControlBox = $false
  $form.TopMost = $true

  $name = New-Object System.Windows.Forms.Label
  $name.Text = $File.Name
  $name.AutoEllipsis = $true
  $name.Font = New-Object System.Drawing.Font($form.Font, [System.Drawing.FontStyle]::Bold)
  $name.Location = New-Object System.Drawing.Point(18, 18)
  $name.Size = New-Object System.Drawing.Size(394, 22)
  $form.Controls.Add($name)

  $status = New-Object System.Windows.Forms.Label
  $status.Text = "Starting upload..."
  $status.Location = New-Object System.Drawing.Point(18, 47)
  $status.Size = New-Object System.Drawing.Size(394, 20)
  $form.Controls.Add($status)

  $progress = New-Object System.Windows.Forms.ProgressBar
  $progress.Location = New-Object System.Drawing.Point(18, 73)
  $progress.Size = New-Object System.Drawing.Size(394, 20)
  $progress.Style = "Continuous"
  $form.Controls.Add($progress)

  $details = New-Object System.Windows.Forms.Label
  $details.Text = "0 B / $(Format-Bytes $File.Length)    Speed: --    ETA: --"
  $details.Location = New-Object System.Drawing.Point(18, 103)
  $details.Size = New-Object System.Drawing.Size(394, 20)
  $form.Controls.Add($details)

  $cancel = New-Object System.Windows.Forms.Button
  $cancel.Text = "Cancel"
  $cancel.Location = New-Object System.Drawing.Point(337, 137)
  $cancel.Size = New-Object System.Drawing.Size(75, 28)
  $form.Controls.Add($cancel)

  $upload = New-Object OShareUpload
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $lastBytes = [int64]0
  $lastSeconds = 0.0
  $speed = 0.0

  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = 250
  $timer.Add_Tick({
    $sent = [int64]$upload.BytesSent
    $elapsed = $clock.Elapsed.TotalSeconds
    $deltaSeconds = $elapsed - $lastSeconds
    if ($deltaSeconds -gt 0 -and $sent -gt $lastBytes) {
      $instantSpeed = ($sent - $lastBytes) / $deltaSeconds
      $speed = if ($speed -eq 0) { $instantSpeed } else { ($speed * 0.7) + ($instantSpeed * 0.3) }
      $lastBytes = $sent
      $lastSeconds = $elapsed
    }
    $percent = if ($upload.TotalBytes -gt 0) { [Math]::Min(100, [Math]::Floor($sent * 100.0 / $upload.TotalBytes)) } else { 0 }
    $progress.Value = [int]$percent
    $eta = if ($speed -gt 0) { ($upload.TotalBytes - $sent) / $speed } else { [double]::NaN }
    $status.Text = "Uploading... $percent%"
    $details.Text = "$(Format-Bytes $sent) / $(Format-Bytes $upload.TotalBytes)    Speed: $(Format-Bytes $speed)/s    ETA: $(Format-Duration $eta)"

    if ($upload.Complete) {
      $timer.Stop()
      $clock.Stop()
      $form.DialogResult = [System.Windows.Forms.DialogResult]::OK
      $form.Close()
    }
  })

  $cancel.Add_Click({
    $cancel.Enabled = $false
    $status.Text = "Cancelling..."
    $upload.Cancel()
  })
  $form.Add_Shown({
    $upload.Start($UploadUrl, $File.FullName, $ContentType)
    $timer.Start()
  })

  [void]$form.ShowDialog()
  $timer.Dispose()
  $form.Dispose()
  if ($upload.Error) { throw $upload.Error }
}

try {
  $file = Get-Item -LiteralPath $FilePath -ErrorAction Stop
  if ($file.PSIsContainer) { throw "Folders are not supported yet. Choose a file." }

  $configPath = Join-Path $PSScriptRoot "config.json"
  if (-not (Test-Path -LiteralPath $configPath)) {
    throw "Missing desktop/config.json. Run install.ps1 first."
  }
  $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
  $configProperties = $config.PSObject.Properties.Name
  if (-not ($configProperties -contains "apiBaseUrl") -or -not $config.apiBaseUrl -or
      -not ($configProperties -contains "uploadSecretProtected") -or -not $config.uploadSecretProtected) {
    throw "The uploader config is missing or outdated. Run install.ps1 again."
  }
  $secretBytes = [Security.Cryptography.ProtectedData]::Unprotect(
    [Convert]::FromBase64String($config.uploadSecretProtected),
    $null,
    [Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  $uploadSecret = [Text.Encoding]::UTF8.GetString($secretBytes)
  if ($config.PSObject.Properties.Name -contains "appName" -and $config.appName) {
    $appName = [string]$config.appName
  }

  $expiresInSeconds = Show-ExpiryDialog $appName
  if ($null -eq $expiresInSeconds) { exit 0 }

  $contentType = Get-ContentType $file.FullName
  $headers = @{ Authorization = "Bearer $uploadSecret" }
  $requestBody = @{
    filename = $file.Name
    size = [int64]$file.Length
    contentType = $contentType
    expiresInSeconds = [int]$expiresInSeconds
  } | ConvertTo-Json -Compress

  $share = Invoke-RestMethod `
    -Uri "$($config.apiBaseUrl.TrimEnd('/'))/shares" `
    -Method Post `
    -Headers $headers `
    -ContentType "application/json" `
    -Body $requestBody

  Show-UploadProgress $file $share.uploadUrl $contentType $appName

  $complete = Invoke-RestMethod `
    -Uri "$($config.apiBaseUrl.TrimEnd('/'))/shares/$($share.token)/complete" `
    -Method Post `
    -Headers $headers

  Set-Clipboard -Value $complete.shareUrl
  [void][System.Windows.Forms.MessageBox]::Show(
    "Share link copied to the clipboard:`r`n`r`n$($complete.shareUrl)",
    "$appName upload complete",
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Information
  )
}
catch {
  [void][System.Windows.Forms.MessageBox]::Show(
    $_.Exception.Message,
    "$appName upload failed",
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Error
  )
  exit 1
}
