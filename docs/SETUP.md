# oShare setup guide

This guide covers a complete personal deployment: AWS, a custom domain, the Windows uploader, Android, and branding.

## Requirements

- An AWS account
- [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)
- Node.js 22 or newer
- Windows PowerShell 5.1+ for the Windows uploader
- JDK 17 and Android SDK 36 to build Android

Configure the AWS CLI before continuing:

```powershell
aws configure
aws sts get-caller-identity
```

The selected AWS identity must be able to deploy CloudFormation stacks and create the resources in `template.yaml`.

## Deploy to AWS

Install dependencies from the repository root:

```powershell
Set-Location .\server
npm ci
Set-Location ..
```

Build and deploy:

```powershell
sam build
sam deploy --guided
```

Use these values when prompted:

| Parameter | Description |
| --- | --- |
| `UploadSecret` | A random secret of at least 16 characters for trusted upload clients |
| `AdminPassword` | A different strong password for the admin page |
| `BrandName` | The name shown in the web app |
| `PublicBaseUrl` | Your HTTPS domain or temporary API Gateway URL, without a trailing slash |

Allow SAM to create IAM roles and save the deployment configuration when prompted. Keep `samconfig.toml` private because it can contain parameter values; it is ignored by this repository.

The deployment outputs an `ApiUrl`. If you do not have a domain yet, deploy again with that output as `PublicBaseUrl` so generated links use the temporary address.

For later updates:

```powershell
sam build
sam deploy
```

See AWS's [SAM deployment guide](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/using-sam-cli-deploy.html) for additional deployment options.

## Connect a custom domain

You can use the generated API Gateway URL or connect a hostname such as `share.example.com`.

1. Request an ACM certificate for the hostname in the same AWS Region as the API.
2. Create a **Regional** custom domain in API Gateway and select the certificate.
3. Map the deployed REST API's `v1` stage to the domain root.
4. Point your DNS record to the Regional API Gateway target.
5. Redeploy with the custom URL as `PublicBaseUrl`.

Route 53 can use an alias record. Other DNS providers can use a CNAME. AWS documents the process in [Set up a Regional custom domain name](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-regional-api-custom-domain-create.html).

## Install the Windows uploader

Run the installer as your normal Windows user:

```powershell
.\desktop\install.ps1 `
  -ApiBaseUrl "https://share.example.com" `
  -AppName "oShare" `
  -MenuLabel "Upload to cloud"
```

The installer prompts for the uploader secret without echoing it or placing it
in shell history. Windows DPAPI encrypts it for the current user before it is
written to `desktop/config.json`; reinstalling under another Windows account
creates a separate configuration.

For a custom context-menu icon, append `-IconPath "C:\path\to\icon.ico"` to the installer command.

The installer creates the ignored `desktop/config.json` and registers the action for the current Windows user.

Remove it with:

```powershell
.\desktop\uninstall.ps1
```

## Build the Android app

Copy and edit the example configuration:

```powershell
Set-Location .\android
Copy-Item .\brand.properties.example .\brand.properties
```

```properties
serviceUrl=https://share.example.com
appName=oShare
applicationId=com.example.oshare
iconBackground=#584AF4
versionCode=1
versionName=1.0
```

Build a debug APK:

```powershell
.\gradlew.bat assembleDebug
```

The APK is written to `app/build/outputs/apk/debug/app-debug.apk`.

### Signed release APK

Create a signing key once and keep it backed up. Android updates must use the same key.

```powershell
keytool -genkeypair -v `
  -keystore .\release-key.jks `
  -alias oshare `
  -keyalg RSA `
  -keysize 2048 `
  -validity 10000

Copy-Item .\keystore.properties.example .\keystore.properties
```

Fill in `keystore.properties`, then build:

```powershell
.\gradlew.bat assembleRelease
```

The signing configuration, keystore, and APKs are ignored by Git. See Android's [app-signing guide](https://developer.android.com/studio/publish/app-signing) for key-management guidance.

## Apply your branding

Set the web name with the SAM `BrandName` parameter. Set the Windows name through `desktop/install.ps1` and Android values through `android/brand.properties`.

Use one square PNG for the website, Android app, and Windows context menu:

```powershell
Set-Location ..
.\scripts\set-logo.ps1 "C:\path\to\your-logo.png"
```

A 1024×1024 or larger image works best. Rebuild the AWS service and Android app after changing it.

## Limits

- Maximum file size: 5 GB
- Videos larger than 80 MB are processed by AWS Elemental MediaConvert into a 720p Discord rendition; the original remains available on the share page and for download
- MediaConvert processing is billed separately by AWS based on video duration
- Expiry choices: 1 hour, 6 hours, 1 day, 3 days, and 7 days
- Expired links stop working immediately; storage cleanup runs every 15 minutes
- The admin login lasts for eight hours

## Keep your deployment safe

- Use different values for `UploadSecret` and `AdminPassword`.
- Treat principals that can read Lambda configuration as trusted: the two
  secrets are Lambda environment variables encrypted at rest by AWS.
- Do not commit `desktop/config.json`, `android/brand.properties`, `android/keystore.properties`, keystores, `samconfig.toml`, or AWS credential files.
- Rotate the uploader secret by redeploying and reinstalling the Windows client.
- Back up the Android signing key somewhere separate from the repository.

## Remove the deployment

```powershell
sam delete
```

The storage bucket and metadata table are retained to prevent accidental data loss. Remove those resources manually only after confirming that you no longer need their contents.
