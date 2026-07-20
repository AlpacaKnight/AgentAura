# Pack agent-aura-codex into installable npm tgz and zip artifacts.
[CmdletBinding()]
param(
    [string]$OutDir
)

$ErrorActionPreference = 'Stop'

$ScriptDir = $PSScriptRoot
if (-not $ScriptDir) {
    $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
$ProjectDir = Split-Path -Parent $ScriptDir
if (-not $OutDir) {
    $OutDir = Join-Path $ProjectDir 'dist'
}

Set-Location $ProjectDir

Write-Host '=== Installing dependencies ===' -ForegroundColor Cyan
npm install

Write-Host '=== Compiling TypeScript ===' -ForegroundColor Cyan
npm run compile

if (-not (Test-Path $OutDir)) {
    New-Item -ItemType Directory -Path $OutDir | Out-Null
}

# 清理旧版本产物，避免版本迭代后残留
Get-ChildItem -LiteralPath $OutDir -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'agent-aura-codex-*.tgz' -or $_.Name -like 'agent-aura-codex-*.zip' } | Remove-Item -Force

Write-Host '=== Creating npm package ===' -ForegroundColor Cyan
npm pack --pack-destination $OutDir

$manifest = Get-Content -Raw -Encoding UTF8 (Join-Path $ProjectDir 'package.json') | ConvertFrom-Json
$zipPath = Join-Path $OutDir "agent-aura-codex-$($manifest.version).zip"
if (Test-Path $zipPath) {
    Remove-Item $zipPath -Force
}

$staging = Join-Path $env:TEMP "agent-aura-codex-pack-$(Get-Random)"
try {
    New-Item -ItemType Directory -Path $staging -Force | Out-Null
    $files = Get-ChildItem -LiteralPath $ProjectDir -Recurse -File | Where-Object {
        $rel = $_.FullName.Substring($ProjectDir.Length).TrimStart('\','/')
        $parts = $rel -split '[\\/]'
        -not ($parts -contains 'node_modules') -and
        -not ($parts -contains 'dist') -and
        -not ($parts -contains '.git') -and
        $_.Extension -notin @('.tgz', '.zip')
    }
    foreach ($file in $files) {
        $rel = $file.FullName.Substring($ProjectDir.Length).TrimStart('\','/')
        $dest = Join-Path $staging $rel
        $parent = Split-Path -Parent $dest
        if (-not (Test-Path $parent)) {
            New-Item -ItemType Directory -Path $parent -Force | Out-Null
        }
        Copy-Item -LiteralPath $file.FullName -Destination $dest -Force
    }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory($staging, $zipPath)
}
finally {
    if (Test-Path $staging) {
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    }
}

$tgz = Get-ChildItem -LiteralPath $OutDir -Filter 'agent-aura-codex-*.tgz' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Write-Host ''
Write-Host 'Done:' -ForegroundColor Green
Write-Host "  $($tgz.FullName)"
Write-Host "  $zipPath"
Write-Host ''
Write-Host 'Install with:'
Write-Host "  npm install -g `"$($tgz.FullName)`""
Write-Host '  agent-aura-codex configure --transport http --host 127.0.0.1 --port 47831 --auto-discover false'
Write-Host '  agent-aura-codex install-hooks'