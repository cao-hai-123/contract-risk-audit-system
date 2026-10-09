# User-authorized prerequisite setup for the project's isolated FAMIE container.
# Never reboots Windows, installs a Linux distribution, or changes disk encryption.
$ErrorActionPreference = 'Stop'
$receiptDirectory = Join-Path $PSScriptRoot '../tmp/performance-library-famie'
[void](New-Item -ItemType Directory -Path $receiptDirectory -Force)
$receipt = @{ checkedAt = (Get-Date).ToString('o'); restarted = $false; steps = @() }
try {
  $feature = & dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart 2>&1
  $featureCode = $LASTEXITCODE
  $feature | Out-File (Join-Path $receiptDirectory 'wsl-platform.log') -Encoding utf8
  $receipt.steps += @{ name = 'VirtualMachinePlatform'; exitCode = $featureCode }
  if ($featureCode -notin @(0, 3010)) { throw "VirtualMachinePlatform failed: $featureCode" }
  & wsl.exe --install --no-distribution 2>&1 | Out-File (Join-Path $receiptDirectory 'wsl-install.log') -Encoding utf8
  $receipt.steps += @{ name = 'WSL'; exitCode = $LASTEXITCODE }
  $receipt.restartMayBeRequired = $true
} catch { $receipt.failure = $_.Exception.Message }
$receipt | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $receiptDirectory 'wsl-prerequisites.json') -Encoding utf8
