#Requires -Version 5.1
<#
.SYNOPSIS
    AgentAura full build script (Windows)
.DESCRIPTION
    Builds all submodules and collects artifacts into a single output directory.
.PARAMETER SkipDesktop
    Skip PetDesktop build.
.PARAMOnly
    Build only the specified module.
.PARAMETER OutDir
    Custom output directory.
.EXAMPLE
    .\scripts\build.ps1
    .\scripts\build.ps1 -SkipDesktop
    .\scripts\build.ps1 -Only claude
    .\scripts\build.ps1 -OutDir C:\out
#>

param(
    [switch]$SkipDesktop,
    [string]$Only,
    [string]$OutDir
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = Split-Path -Parent $ScriptDir

if (-not $OutDir) {
    $OutDir = Join-Path $RootDir "dist"
}
if (-not (Test-Path $OutDir)) {
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}
$OutDir = [System.IO.Path]::GetFullPath($OutDir)

$Failed = @()

function Build-Module {
    param(
        [string]$Name,
        [string]$Dir,
        [string]$Script,
        [string[]]$ScriptArgs = @()
    )

    if ($Only -and $Only -ne $Name) {
        return
    }

    $ModuleOut = Join-Path (Join-Path $OutDir "plugin") $Name
    if (Test-Path $ModuleOut) {
        Remove-Item -LiteralPath $ModuleOut -Recurse -Force
    }
    New-Item -ItemType Directory -Path $ModuleOut -Force | Out-Null

    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  Building: $Name"
    Write-Host "========================================" -ForegroundColor Cyan

    $prevDir = Get-Location
    try {
        Set-Location $Dir
        $scriptPath = Join-Path $Dir $Script

        if ($Script.EndsWith(".ps1")) {
            & powershell -ExecutionPolicy Bypass -File $scriptPath @ScriptArgs
        } else {
            & bash $Script @ScriptArgs
        }

        if ($LASTEXITCODE -ne 0) {
            throw "Build failed with exit code $LASTEXITCODE"
        }
    } catch {
        Write-Host "FAILED: $Name - $_" -ForegroundColor Red
        $script:Failed += $Name
        return
    } finally {
        Set-Location $prevDir
    }

    # Collect artifacts from dist/ and project root
    $CollectDirs = @((Join-Path $Dir "dist"), $Dir)
    foreach ($collectDir in $CollectDirs) {
        if (Test-Path $collectDir) {
            Get-ChildItem $collectDir -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -in ".tgz",".zip",".vsix" } | ForEach-Object {
                $dest = Join-Path $ModuleOut $_.Name
                Copy-Item $_.FullName $dest -Force
            }
        }
    }

    Write-Host "Artifacts collected: $ModuleOut" -ForegroundColor Green
}

# --- Plugins ---
$PluginsDir = Join-Path $RootDir "Agent_Plugin"

Build-Module "claude"    (Join-Path $PluginsDir "agent-aura-claude")    "scripts\build.ps1" @("-Pack", "-OutDir", (Join-Path $PluginsDir "agent-aura-claude\dist"))
Build-Module "codex"     (Join-Path $PluginsDir "agent-aura-codex")     "scripts\pack.ps1"  @((Join-Path $PluginsDir "agent-aura-codex\dist"))
Build-Module "copilot"   (Join-Path $PluginsDir "agent-aura-copilot")   "scripts\pack.ps1"  @((Join-Path $PluginsDir "agent-aura-copilot\dist"))
Build-Module "kimi-code" (Join-Path $PluginsDir "agent-aura-kimi-code") "scripts\pack.ps1"  @((Join-Path $PluginsDir "agent-aura-kimi-code\dist"))
Build-Module "qwencode"  (Join-Path $PluginsDir "agent-aura-qwencode")  "scripts\pack.ps1"  @((Join-Path $PluginsDir "agent-aura-qwencode\dist"))
Build-Module "qwenpaw"   (Join-Path $PluginsDir "qwenpaw-plugin")       "scripts\pack.ps1"  @((Join-Path $PluginsDir "qwenpaw-plugin\dist"))

# --- PetDesktop ---
if (-not $SkipDesktop -and (-not $Only -or $Only -eq "desktop")) {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  Building: desktop"
    Write-Host "========================================" -ForegroundColor Cyan

    $DesktopOut = Join-Path $OutDir "desktop"
    if (Test-Path $DesktopOut) {
        Remove-Item -LiteralPath $DesktopOut -Recurse -Force
    }
    New-Item -ItemType Directory -Path $DesktopOut -Force | Out-Null

    $prevDir = Get-Location
    try {
        Set-Location (Join-Path $RootDir "PetDesktop")
        $devScript = Join-Path (Get-Location) "scripts\dev.ps1"
        & powershell -ExecutionPolicy Bypass -File $devScript build

        if ($LASTEXITCODE -ne 0) {
            throw "PetDesktop build failed"
        }
    } catch {
        Write-Host "FAILED: desktop - $_" -ForegroundColor Red
        $Failed += "desktop"
    } finally {
        Set-Location $prevDir
    }

    # Collect installers
    $Bundle = Join-Path $RootDir "PetDesktop\src-tauri\target\release\bundle"
    $Patterns = @("msi\*.msi", "nsis\*.exe", "deb\*.deb", "appimage\*.AppImage", "dmg\*.dmg", "portable\*.zip")
    foreach ($pattern in $Patterns) {
        $src = Join-Path $Bundle $pattern
        if (Test-Path $src) {
            Get-ChildItem $src | ForEach-Object {
                Copy-Item $_.FullName (Join-Path $DesktopOut $_.Name) -Force
            }
        }
    }

    Write-Host "Artifacts collected: $DesktopOut" -ForegroundColor Green
}

# --- Summary ---
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Build Summary"
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Output: $OutDir"
Write-Host ""

$SummaryDirs = @()
$PluginOut = Join-Path $OutDir "plugin"
if (Test-Path $PluginOut) {
    $SummaryDirs += Get-ChildItem $PluginOut -Directory | Where-Object { -not $Only -or $_.Name -eq $Only }
}
$DesktopSummary = Join-Path $OutDir "desktop"
if ((-not $SkipDesktop) -and (-not $Only -or $Only -eq "desktop") -and (Test-Path $DesktopSummary)) {
    $SummaryDirs += Get-Item $DesktopSummary
}

$SummaryDirs | ForEach-Object {
    $name = $_.Name
    $files = Get-ChildItem $_.FullName -File
    $count = $files.Count
    if ($count -gt 0) {
        Write-Host "  ${name}: $count file(s)" -ForegroundColor Yellow
        $files | ForEach-Object {
            $size = [math]::Round($_.Length / 1MB, 2)
            Write-Host "    $($_.Name) ($size MB)" -ForegroundColor Gray
        }
    } else {
        Write-Host "  ${name}: (no artifacts)" -ForegroundColor DarkGray
    }
}

if ($Failed.Count -gt 0) {
    Write-Host ""
    Write-Host "FAILED modules: $($Failed -join ', ')" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "All builds completed successfully." -ForegroundColor Green
