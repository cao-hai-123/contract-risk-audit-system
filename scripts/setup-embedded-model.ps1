$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $projectRoot 'runtime\llama.cpp'
$modelDir = Join-Path $projectRoot 'models'
$downloadDir = Join-Path $projectRoot 'runtime\downloads'
$modelPath = Join-Path $modelDir 'Qwen3-8B-Q4_K_M.gguf'
$modelPartialPath = "$modelPath.part"
$modelUrl = 'https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf?download=true'
$modelMirrorUrl = 'https://hf-mirror.com/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf'
$modelApiUrl = 'https://huggingface.co/api/models/Qwen/Qwen3-8B-GGUF?blobs=true'

New-Item -ItemType Directory -Force -Path $runtimeDir, $modelDir, $downloadDir | Out-Null

function Get-Sha256([string]$Path) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $stream = [System.IO.File]::OpenRead($Path)
    try { return ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose() }
  } finally { $sha.Dispose() }
}

$modelMetadata = Invoke-RestMethod -Uri $modelApiUrl
$modelInfo = $modelMetadata.siblings | Where-Object { $_.rfilename -eq 'Qwen3-8B-Q4_K_M.gguf' } | Select-Object -First 1
if (-not $modelInfo -or -not $modelInfo.size -or -not $modelInfo.lfs.sha256) { throw 'The official Qwen model metadata was not found.' }
$expectedModelBytes = [Int64]$modelInfo.size
$expectedModelHash = $modelInfo.lfs.sha256

$hasVerifiedModel = $false
if ((Test-Path $modelPath) -and (Get-Item $modelPath).Length -eq $expectedModelBytes) {
  $hasVerifiedModel = (Get-Sha256 $modelPath) -eq $expectedModelHash.ToLowerInvariant()
}

if ($hasVerifiedModel) {
  Write-Host 'Qwen3-8B model already exists.'
} else {
  Write-Host 'Downloading Qwen3-8B Q4_K_M GGUF from the official Qwen repository with resume and size verification...'
  & curl.exe --fail --location --retry 3 --retry-all-errors --retry-delay 5 --continue-at - --output $modelPartialPath $modelUrl
  if ($LASTEXITCODE -ne 0) {
    Write-Host 'Official model delivery endpoint is unavailable. Retrying the identical public model through a verified transfer mirror...'
    & curl.exe --fail --location --retry 5 --retry-all-errors --retry-delay 5 --continue-at - --output $modelPartialPath $modelMirrorUrl
  }
  if ($LASTEXITCODE -ne 0) { throw "The model download command failed with exit code $LASTEXITCODE. Re-run this command to resume." }
  if (-not (Test-Path $modelPartialPath) -or (Get-Item $modelPartialPath).Length -ne $expectedModelBytes) { throw 'The downloaded model size does not match the official Qwen metadata. Re-run this command to resume.' }
  if ((Get-Sha256 $modelPartialPath) -ne $expectedModelHash.ToLowerInvariant()) { throw 'The downloaded model SHA-256 does not match the official Qwen metadata.' }
  Move-Item -Force -Path $modelPartialPath -Destination $modelPath
}

$serverPath = Join-Path $runtimeDir 'llama-server.exe'
if (-not (Test-Path $serverPath)) {
  Write-Host 'Downloading the official llama.cpp Windows CPU runtime...'
  $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest'
  $asset = $release.assets | Where-Object { $_.name -match '^llama-.*-bin-win-cpu-x64\.zip$' } | Select-Object -First 1
  if (-not $asset -or $asset.digest -notmatch '^sha256:([a-f0-9]{64})$') { throw 'Official CPU runtime asset and digest were not found.' }
  $expectedRuntimeHash = $Matches[1]
  $runtimeZip = Join-Path $downloadDir $asset.name
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $runtimeZip
  if ((Get-Sha256 $runtimeZip) -ne $expectedRuntimeHash) { throw 'Runtime SHA-256 mismatch.' }
  Expand-Archive -Force -LiteralPath $runtimeZip -DestinationPath $runtimeDir

}

if (-not (Test-Path $serverPath)) { throw 'llama-server.exe was not found after extraction.' }
Write-Host 'Embedded local model runtime is ready.'
