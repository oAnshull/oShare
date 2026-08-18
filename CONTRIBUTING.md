# Contributing

Bug reports and focused pull requests are welcome. For security issues, follow
[SECURITY.md](SECURITY.md) instead of opening a public issue.

Before submitting a change, run:

```powershell
Set-Location server
npm ci
npm run check
npm test
```

Changes to `template.yaml` or the Android client should also pass the matching
SAM and Gradle commands documented in the README.
