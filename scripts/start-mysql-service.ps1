$ErrorActionPreference = 'Stop'
$resultDirectory = Join-Path $PSScriptRoot '../tmp/startup-recovery'
[void](New-Item -ItemType Directory -Path $resultDirectory -Force)
$resultFile = Join-Path $resultDirectory 'mysql-service-start.json'
try {
  # Start the existing service only. Never modify its configuration or database files.
  $mysqlService = Get-Service -Name 'MySQL' -ErrorAction Stop
  if ($mysqlService.Status -ne 'Running') {
    Start-Service -Name 'MySQL' -ErrorAction Stop
    $mysqlService.WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
  }
  $mysqlService.Refresh()
  @{ success = $true; service = $mysqlService.Name; status = $mysqlService.Status.ToString(); checkedAt = (Get-Date).ToString('o') } |
    ConvertTo-Json | Set-Content -LiteralPath $resultFile -Encoding UTF8
} catch {
  @{ success = $false; service = 'MySQL'; message = $_.Exception.Message; checkedAt = (Get-Date).ToString('o') } |
    ConvertTo-Json | Set-Content -LiteralPath $resultFile -Encoding UTF8
  exit 1
}
