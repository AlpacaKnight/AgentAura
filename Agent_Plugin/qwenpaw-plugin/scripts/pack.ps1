# -*- coding: utf-8 -*-
<#
.SYNOPSIS
    Pack the agentaura plugin into a versioned .zip.

.DESCRIPTION
    Builds the frontend bundle (npm install + vite build -> ../dist/index.js),
    then zips all plugin source files (excluding node_modules / caches) into
    dist/agentaura-<ver>.zip. The resulting archive is directly
    installable via `qwenpaw plugin install`.

.PARAMETER OutDir
    Output directory for the .zip. Defaults to ../dist.

.PARAMETER SkipFrontendBuild
    Skip the npm build step (use when dist/index.js is already up to date).

.EXAMPLE
    PS> .\scripts\pack.ps1
    PS> .\scripts\pack.ps1 -SkipFrontendBuild
#>

[CmdletBinding()]
param(
    [string]$OutDir,
    [switch]$SkipFrontendBuild
)

$ErrorActionPreference = 'Stop'

$ScriptDir = $PSScriptRoot
if (-not $ScriptDir) {
    $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
$PluginDir = Split-Path -Parent $ScriptDir
$Manifest  = Join-Path $PluginDir 'plugin.json'
$FrontendDir = Join-Path $PluginDir 'ui'

if (-not (Test-Path $Manifest)) {
    throw "plugin.json not found at $Manifest"
}

if (-not $OutDir) {
    $OutDir = Join-Path $PluginDir 'dist'
}

# --- read version + id from plugin.json (UTF-8 for i18n fields) ---
$raw = [System.IO.File]::ReadAllText($Manifest, [System.Text.Encoding]::UTF8)
$manifestObj = $raw | ConvertFrom-Json
$version = $manifestObj.version
$pluginId = $manifestObj.id
if (-not $version) { throw "plugin.json missing 'version'" }
if (-not $pluginId) { throw "plugin.json missing 'id'" }

# --- build frontend bundle ---
if (-not $SkipFrontendBuild -and (Test-Path $FrontendDir)) {
    Write-Host "Building frontend bundle..."
    Push-Location $FrontendDir
    try {
        if (-not (Test-Path (Join-Path $FrontendDir 'node_modules'))) {
            & npm install
            if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
        }
        & npm run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
    }
    finally {
        Pop-Location
    }
    $bundle = Join-Path $PluginDir 'dist\index.js'
    if (-not (Test-Path $bundle)) {
        throw "frontend build did not produce dist/index.js"
    }
    Write-Host "Frontend bundle: $bundle"
}

# --- prepare output dir ---
if (-not (Test-Path $OutDir)) {
    New-Item -ItemType Directory -Path $OutDir | Out-Null
}

# 清理旧版本 zip（保留 index.js 前端构建产物）
Get-ChildItem -LiteralPath $OutDir -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "$pluginId-*.zip" } | Remove-Item -Force

$zipName = "$pluginId-$version.zip"
$zipPath = Join-Path $OutDir $zipName
if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}

# --- collect files (exclude dev/build/cache artifacts) ---
# Key exclusions: ui/node_modules, ui/dist (vite's own out),
# __pycache__, .git, and the previously-built zip in root dist/.
# The root dist/ IS included because it holds the built index.js that
# plugin.json references as entry.frontend.
$excludeDirs = @(
    'ui\dist', 'ui/dist',
    'node_modules', 'ui\node_modules', 'ui/node_modules',
    '__pycache__', '.pytest_cache', '.mypy_cache', '.git',
    'tests'
)
$excludeFiles = @('.gitignore', 'package-lock.json')

$files = Get-ChildItem -LiteralPath $PluginDir -Recurse -File | Where-Object {
    $rel = $_.FullName.Substring($PluginDir.Length).TrimStart('\','/')
    $parts = $rel -split '[\\/]'
    $skip = $false
    foreach ($d in $excludeDirs) {
        $dParts = $d -split '[\\/]'
        # Match if any sub-path of the file equals the excluded dir path.
        for ($i = 0; $i -le $parts.Length - $dParts.Length; $i++) {
            $slice = $parts[$i..($i + $dParts.Length - 1)] -join '\'
            if ($slice -ieq ($dParts -join '\')) { $skip = $true; break }
        }
        if ($skip) { break }
    }
    if (-not $skip -and $excludeFiles -contains $_.Name) { $skip = $true }
    if (-not $skip -and $_.Extension -in @('.pyc','.pyo')) { $skip = $true }
    -not $skip
}

if ($files.Count -eq 0) {
    throw "no files to pack in $PluginDir"
}

# --- build zip ---
$staging = Join-Path $env:TEMP "agentaura-pack-$(Get-Random)"
try {
    New-Item -ItemType Directory -Path $staging -Force | Out-Null
    foreach ($f in $files) {
        $rel = $f.FullName.Substring($PluginDir.Length).TrimStart('\','/')
        $dest = Join-Path $staging $rel
        $destParent = Split-Path -Parent $dest
        if (-not (Test-Path $destParent)) {
            New-Item -ItemType Directory -Path $destParent -Force | Out-Null
        }
        Copy-Item -LiteralPath $f.FullName -Destination $dest -Force
    }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory($staging, $zipPath)
} finally {
    if (Test-Path $staging) {
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# --- report ---
$size = (Get-Item -LiteralPath $zipPath).Length
Write-Host ""
Write-Host ("Packed {0} file(s) -> {1} ({2:N0} bytes)" -f $files.Count, $zipPath, $size)
Write-Host ""
Write-Host "Install with:"
Write-Host "  qwenpaw plugin install `"$zipPath`""
