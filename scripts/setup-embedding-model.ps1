$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$modelDir = Join-Path $projectRoot 'models'
$modelPath = Join-Path $modelDir 'Qwen3-Embedding-0.6B-Q8_0.gguf'
$modelPartialPath = "$modelPath.part"
$modelApiUrl = 'https://huggingface.co/api/models/Qwen/Qwen3-Embedding-0.6B-GGUF?blobs=true'
$modelUrl = 'https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/Qwen3-Embedding-0.6B-Q8_0.gguf?download=true'
$modelMirrorUrl = 'https://hf-mirror.com/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/Qwen3-Embedding-0.6B-Q8_0.gguf'

New-Item -ItemType Directory -Force -Path $modelDir | Out-Null

function Get-Sha256([string]$Path) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $stream = [System.IO.File]::OpenRead($Path)
    try {
      return ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    } finally {
      $stream.Dispose()
    }
  } finally {
    $sha.Dispose()
  }
}

$modelMetadata = Invoke-RestMethod -Uri $modelApiUrl
$modelInfo = $modelMetadata.siblings | Where-Object { $_.rfilename -eq 'Qwen3-Embedding-0.6B-Q8_0.gguf' } | Select-Object -First 1
if (-not $modelInfo -or -not $modelInfo.size -or -not $modelInfo.lfs.sha256) { throw 'The official Qwen embedding-model metadata was not found.' }
$expectedBytes = [Int64]$modelInfo.size
$expectedHash = $modelInfo.lfs.sha256

$hasVerifiedModel = $false
if ((Test-Path $modelPath) -and (Get-Item $modelPath).Length -eq $expectedBytes) {
  $hasVerifiedModel = (Get-Sha256 $modelPath) -eq $expectedHash.ToLowerInvariant()
}

if ($hasVerifiedModel) {
  Write-Host 'Qwen3-Embedding-0.6B Q8_0 model already exists and passed SHA-256 verification.'
  exit 0
}

if ((Test-Path $modelPartialPath) -and (Get-Item $modelPartialPath).Length -eq $expectedBytes -and (Get-Sha256 $modelPartialPath) -eq $expectedHash.ToLowerInvariant()) {
  Move-Item -Force -Path $modelPartialPath -Destination $modelPath
  Write-Host 'Recovered and verified the previously completed embedding-model download.'
  exit 0
}

if (Test-Path $modelPath) { Remove-Item -Force -Path $modelPath }
Write-Host 'Downloading Qwen3-Embedding-0.6B Q8_0 GGUF from the official Qwen repository with resume, size, and SHA-256 verification...'
& curl.exe --fail --location --retry 3 --retry-all-errors --retry-delay 5 --continue-at - --output $modelPartialPath $modelUrl
if ($LASTEXITCODE -ne 0) {
  Write-Host 'Official model delivery endpoint is unavailable. Retrying the identical public model through a verified transfer mirror...'
  & curl.exe --fail --location --retry 5 --retry-all-errors --retry-delay 5 --continue-at - --output $modelPartialPath $modelMirrorUrl
}
if ($LASTEXITCODE -ne 0) { throw "The embedding-model download failed with exit code $LASTEXITCODE. Re-run this command to resume." }
if (-not (Test-Path $modelPartialPath) -or (Get-Item $modelPartialPath).Length -ne $expectedBytes) { throw 'The downloaded embedding model size does not match official metadata. Re-run this command to resume.' }
if ((Get-Sha256 $modelPartialPath) -ne $expectedHash.ToLowerInvariant()) { throw 'The downloaded embedding model SHA-256 does not match official metadata.' }
Move-Item -Force -Path $modelPartialPath -Destination $modelPath
Write-Host 'Qwen3-Embedding-0.6B Q8_0 is ready for the local-only embedding service.'
