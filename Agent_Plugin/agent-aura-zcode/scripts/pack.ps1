#!/usr/bin/env pwsh
# Build and package agent-aura-zcode (Windows).
param(
    [switch]$clean,
    [switch]$noPack,
    [string]$outDir = ""
)

$ErrorActionPreference = "Stop"

$SCRIPT_DIR = Split-Path -Parent $PSCommandPath
$PROJECT_DIR = Split-Path -Parent $SCRIPT_DIR
if (-not $outDir) { $outDir = Join-Path $PROJECT_DIR "dist" }

Set-Location $PROJECT_DIR

if ($clean) {
    if (Test-Path "out") { Remove-Item -Recurse -Force "out" }
}

Write-Host "=== Installing dependencies ==="
npm install

Write-Host "=== Compiling TypeScript ==="
npm run compile
if (-not (Test-Path "out/index.js")) {
    Write-Error "Build failed: out/index.js not found"
    exit 1
}
Write-Host "Build complete: $PROJECT_DIR/out/index.js"

if ($noPack) { exit 0 }

# ── Pack .tgz ──────────────────────────────────────────
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }

# Remove old tarballs to avoid stale versions
Remove-Item -Force -ErrorAction SilentlyContinue "$outDir/agent-aura-zcode-*.tgz"

Write-Host "=== Creating npm package ==="
npm pack --ignore-scripts --pack-destination $outDir

$TGZ = @(Get-ChildItem -Path $outDir -Filter "agent-aura-zcode-*.tgz" | Sort-Object LastWriteTime -Descending)[0]
if (-not $TGZ) {
    Write-Error "Package creation failed"
    exit 1
}

Write-Host ""
Write-Host "Done: $($TGZ.FullName)"
Write-Host ""
Write-Host "Install with:"
Write-Host "  npm install -g ""$($TGZ.FullName)"""
Write-Host "  agent-aura-zcode plugin-path"
Write-Host "  Then in ZCode: Settings > Plugin Management > Discover > '+' to add the plugin-path directory"
Write-Host "  Then install agent-aura-zcode"
Write-Host "  agent-aura-zcode configure --transport http --host 127.0.0.1 --port 47831 --auto-discover false"