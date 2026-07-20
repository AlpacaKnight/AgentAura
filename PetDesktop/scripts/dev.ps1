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

function Remove-ProjectBuildDirectory([string]$Path) {
    $ProjectFullPath = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    $TargetFullPath = [System.IO.Path]::GetFullPath($Path)
    $ExpectedPrefix = $ProjectFullPath + [System.IO.Path]::DirectorySeparatorChar
    if (-not $TargetFullPath.StartsWith(
        $ExpectedPrefix,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw "Refusing to remove a build directory outside PetDesktop: $TargetFullPath"
    }
    if (Test-Path -LiteralPath $TargetFullPath) {
        $LastError = $null
        for ($Attempt = 1; $Attempt -le 3; $Attempt++) {
            try {
                Remove-Item -LiteralPath $TargetFullPath -Recurse -Force
                return
            }
            catch {
                $LastError = $_
                if ($Attempt -lt 3) {
                    Start-Sleep -Milliseconds 300
                }
            }
        }
        throw $LastError
    }
}

function Stop-ProjectBundleProcesses([string]$BundlePath) {
    $BundleFullPath = [System.IO.Path]::GetFullPath($BundlePath).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    $BundlePrefix = $BundleFullPath + [System.IO.Path]::DirectorySeparatorChar
    $Processes = Get-Process -Name "AgentAura-PetDesktop" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Path -and $_.Path.StartsWith(
                $BundlePrefix,
                [System.StringComparison]::OrdinalIgnoreCase
            )
        }

    foreach ($Process in $Processes) {
        Write-Host "Stopping old bundled PetDesktop process (PID $($Process.Id))..." -ForegroundColor DarkGray
        [void]$Process.CloseMainWindow()
    }

    if ($Processes) {
        $Processes | Wait-Process -Timeout 2 -ErrorAction SilentlyContinue
        $Processes = $Processes | Where-Object { -not $_.HasExited }
        foreach ($Process in $Processes) {
            Stop-Process -Id $Process.Id -Force -ErrorAction Stop
        }
        if ($Processes) {
            $Processes | Wait-Process -Timeout 5 -ErrorAction Stop
        }
    }
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

        # 1. Remove all previous installers/portable packages. Keep the rest
        # of target/release so Rust incremental compilation can still be reused.
        Write-Host "Removing previous bundle outputs..." -ForegroundColor DarkGray
        Stop-ProjectBundleProcesses $BundleDir
        Remove-ProjectBuildDirectory $BundleDir
        @("msi", "nsis", "portable") | ForEach-Object {
            New-Item -ItemType Directory -Path (Join-Path $BundleDir $_) -Force | Out-Null
        }

        # 2. tauri build (MSI + NSIS)
        npm run tauri -- build
        if ($LASTEXITCODE -ne 0) {
            Write-Host "[ERROR] Build failed" -ForegroundColor Red
            exit 1
        }

        # 3. portable exe
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
            "- HTTP/UDP/Serial/BLE hardware bridge (ESP32)",
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

        # 4. summary
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
