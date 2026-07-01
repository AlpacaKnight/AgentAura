#Requires -Version 5.1
<#
.SYNOPSIS
    PetDesktop build script (Windows)
.DESCRIPTION
    Actions: dev / build / test / clean
    - dev:   start dev server
    - build: build installers (MSI + NSIS) and portable exe
    - test:  run frontend + backend tests
    - clean: remove build caches
.EXAMPLE
    .\scripts\dev.ps1
    .\scripts\dev.ps1 dev
    .\scripts\dev.ps1 build
    .\scripts\dev.ps1 test
    .\scripts\dev.ps1 clean
#>

param(
    [Parameter(Position = 0)]
    [ValidateSet("dev", "build", "test", "clean")]
    [string]$Action = "dev"
)

$ErrorActionPreference = "Stop"

# --- locate project root ---
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
Set-Location $ProjectRoot

$PlatformLabel = "Windows ($env:PROCESSOR_ARCHITECTURE)"

# --- helpers ---
function Test-Command($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Assert-Prereqs {
    if (-not (Test-Command "cargo")) {
        Write-Host "[ERROR] cargo not found. Install Rust: https://rustup.rs" -ForegroundColor Red
        exit 1
    }
    if (-not (Test-Command "node")) {
        Write-Host "[ERROR] node not found. Install Node.js: https://nodejs.org" -ForegroundColor Red
        exit 1
    }
}

function Get-AppVersion {
    $confPath = Join-Path $ProjectRoot "src-tauri\tauri.conf.json"
    $conf = Get-Content $confPath -Raw | ConvertFrom-Json
    return $conf.version
}

# --- actions ---
switch ($Action) {
    "dev" {
        Assert-Prereqs
        Write-Host "Starting dev server ($PlatformLabel)..." -ForegroundColor Green
        npm run tauri -- dev
    }
    "build" {
        Assert-Prereqs
        $Version = Get-AppVersion
        $ReleaseDir = Join-Path $ProjectRoot "src-tauri\target\release"
        $BundleDir = Join-Path $ReleaseDir "bundle"
        $PortableDir = Join-Path $BundleDir "portable\AgentAura-PetDesktop-$Version-portable"
        $ZipPath = Join-Path $BundleDir "portable\AgentAura-PetDesktop-$Version-portable.zip"

        Write-Host "Building ($PlatformLabel)..." -ForegroundColor Green

        # 1. tauri build (MSI + NSIS)
        npm run tauri -- build
        if ($LASTEXITCODE -ne 0) {
            Write-Host "[ERROR] Build failed" -ForegroundColor Red
            exit 1
        }

        # 2. portable exe
        Write-Host "Collecting portable files..." -ForegroundColor Green
        if (Test-Path $PortableDir) { Remove-Item -Recurse -Force $PortableDir }
        if (Test-Path $ZipPath) { Remove-Item -Force $ZipPath }
        New-Item -ItemType Directory -Path $PortableDir -Force | Out-Null

        $SrcExe = Join-Path $ReleaseDir "agentaura-pet-desktop.exe"
        $DstExe = Join-Path $PortableDir "AgentAura-PetDesktop.exe"
        Copy-Item $SrcExe $DstExe

        $Dll = Get-ChildItem (Join-Path $ReleaseDir "build\webview2-com-sys-*\out\x64\WebView2Loader.dll") -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($Dll) { Copy-Item $Dll.FullName (Join-Path $PortableDir "WebView2Loader.dll") }

        $ResSrc = Join-Path $ReleaseDir "resources"
        if (Test-Path $ResSrc) {
            Copy-Item $ResSrc (Join-Path $PortableDir "resources") -Recurse
        }

        $LicSrc = Join-Path $ProjectRoot "LICENSE"
        if (Test-Path $LicSrc) { Copy-Item $LicSrc $PortableDir }

        # README (array-based, no here-string)
        $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        $ReadmeLines = @(
            "AgentAura PetDesktop v$Version - Portable",
            "",
            "[Requirements]",
            "- Windows 10/11 with WebView2 Runtime",
            "  Win11 has it preinstalled. Win10 download:",
            "  https://developer.microsoft.com/microsoft-edge/webview2/",
            "",
            "[Usage]",
            "1. Double-click AgentAura-PetDesktop.exe",
            "2. No install needed, can run from USB drive",
            "",
            "[Features]",
            "- Desktop pet showing AI Agent status",
            "- Codex / Claude Code / Kimi Code / GitHub Copilot / QwenPaw",
            "- HTTP/UDP/Serial hardware bridge (ESP32 RingLight)",
            "- System tray, autostart, multi-monitor",
            "",
            "[API]",
            "- HTTP: 127.0.0.1:47831",
            "- UDP:  127.0.0.1:8888",
            "",
            "[Uninstall]",
            "- Just delete this folder"
        )
        $ReadmePath = Join-Path $PortableDir "README.txt"
        [System.IO.File]::WriteAllLines($ReadmePath, $ReadmeLines, $Utf8NoBom)

        Write-Host "Creating portable zip..." -ForegroundColor Green
        Compress-Archive -Path "$PortableDir\*" -DestinationPath $ZipPath -Force

        # 3. summary
        $ExeSize = [math]::Round((Get-Item $DstExe).Length / 1MB, 2)
        $ZipSize = [math]::Round((Get-Item $ZipPath).Length / 1MB, 2)

        Write-Host ""
        Write-Host "Build done!" -ForegroundColor Green
        Write-Host ""
        Write-Host "Installers:" -ForegroundColor Yellow
        Get-ChildItem $BundleDir -Recurse -File | Where-Object { $_.Extension -in ".msi",".exe" } | ForEach-Object {
            $Size = [math]::Round($_.Length / 1MB, 2)
            Write-Host ("  " + $_.FullName + " (" + $Size + " MB)") -ForegroundColor Gray
        }
        Write-Host ""
        Write-Host "Portable:" -ForegroundColor Yellow
        Write-Host ("  " + $ZipPath + " (" + $ZipSize + " MB)") -ForegroundColor Gray
        Write-Host ("  " + $PortableDir + " (" + $ExeSize + " MB exe)") -ForegroundColor Gray
    }
    "test" {
        Assert-Prereqs
        Write-Host "Running tests ($PlatformLabel)..." -ForegroundColor Green
        Write-Host "  Frontend tests..." -ForegroundColor Gray
        npm test
        Write-Host "  Backend tests..." -ForegroundColor Gray
        Push-Location (Join-Path $ProjectRoot "src-tauri")
        cargo test
        Pop-Location
        Write-Host "All tests passed" -ForegroundColor Green
    }
    "clean" {
        Write-Host "Cleaning build caches ($PlatformLabel)..." -ForegroundColor Green
        $TargetDir = Join-Path $ProjectRoot "src-tauri\target"
        if (Test-Path $TargetDir) {
            Push-Location (Join-Path $ProjectRoot "src-tauri")
            cargo clean
            Pop-Location
        }
        $ViteCache = Join-Path $ProjectRoot "node_modules\.vite"
        if (Test-Path $ViteCache) {
            Remove-Item -Recurse -Force $ViteCache
        }
        Write-Host "Clean done" -ForegroundColor Green
    }
}
