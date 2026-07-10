#!/usr/bin/env pwsh
# Build and package agent-aura-zcode (Windows).
param(
    [switch]$clean,
    [string]$outDir = ""
)

$ErrorActionPreference = "Stop"

$PACKAGE_NAME = "agent-aura-zcode"
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

# ── Pack .tgz ──────────────────────────────────────────
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }

# Remove old tarballs to avoid stale versions
Remove-Item -Force -ErrorAction SilentlyContinue "$outDir/$PACKAGE_NAME-*.tgz"
Remove-Item -Force -ErrorAction SilentlyContinue "$outDir/$PACKAGE_NAME-*.zip"

Write-Host "=== Creating npm package ==="
npm pack --ignore-scripts --pack-destination $outDir

$TGZ = @(Get-ChildItem -Path $outDir -Filter "$PACKAGE_NAME-*.tgz" | Sort-Object LastWriteTime -Descending)[0]
if (-not $TGZ) {
    Write-Error "Package creation failed"
    exit 1
}

Write-Host ""
Write-Host "Done: $($TGZ.FullName)"