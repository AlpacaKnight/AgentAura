# Build, test, and optionally package agent-aura-claude.
[CmdletBinding()]
param(
    [switch]$Clean,
    [switch]$Pack,
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
$OutDir = [IO.Path]::GetFullPath($OutDir)

Set-Location $ProjectDir

if ($Clean -and (Test-Path 'out')) {
    Remove-Item -LiteralPath 'out' -Recurse -Force
}

Write-Host '=== Installing dependencies ===' -ForegroundColor Cyan
npm install
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host '=== Compiling TypeScript and running tests ===' -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if (-not (Test-Path 'out/index.js')) {
    throw 'Build completed without producing out/index.js'
}
Write-Host "Build complete: $(Join-Path $ProjectDir 'out/index.js')" -ForegroundColor Green

if (-not $Pack) {
    exit 0
}

New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

Write-Host '=== Creating npm package ===' -ForegroundColor Cyan
npm pack --ignore-scripts --pack-destination $OutDir
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$manifest = Get-Content -Raw -Encoding UTF8 (Join-Path $ProjectDir 'package.json') | ConvertFrom-Json
$zipPath = Join-Path $OutDir "agent-aura-claude-$($manifest.version).zip"
if (Test-Path $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}

$staging = Join-Path $env:TEMP "agent-aura-claude-pack-$(Get-Random)"
try {
    New-Item -ItemType Directory -Path $staging -Force | Out-Null
    $files = Get-ChildItem -LiteralPath $ProjectDir -Recurse -File | Where-Object {
        $full = $_.FullName
        $rel = $full.Substring($ProjectDir.Length).TrimStart('\','/')
        $parts = $rel -split '[\\/]'
        -not $full.StartsWith($OutDir + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -and
        -not ($parts -contains 'node_modules') -and
        -not ($parts -contains 'dist') -and
        -not ($parts -contains '.git') -and
        $_.Extension -notin @('.tgz', '.zip')
    }
    foreach ($file in $files) {
        $rel = $file.FullName.Substring($ProjectDir.Length).TrimStart('\','/')
        $dest = Join-Path $staging $rel
        New-Item -ItemType Directory -Path (Split-Path -Parent $dest) -Force | Out-Null
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

$tgz = Get-ChildItem -LiteralPath $OutDir -Filter 'agent-aura-claude-*.tgz' |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
Write-Host ''
Write-Host 'Package complete:' -ForegroundColor Green
Write-Host "  $($tgz.FullName)"
Write-Host "  $zipPath"
