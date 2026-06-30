<#
.SYNOPSIS
    PetDesktop 跨平台开发脚本 (Windows)
.DESCRIPTION
    支持 dev/build/test/clean 四个命令
    Windows 上使用 MSVC 工具链，无需隔离 conda
.NOTES
    需要预装: Rust, Node.js, Visual Studio Build Tools (C++ 桌面开发)
.EXAMPLE
    .\scripts\dev.ps1
    .\scripts\dev.ps1 dev
    .\scripts\dev.ps1 build
    .\scripts\dev.ps1 test
    .\scripts\dev.ps1 clean
#>

param(
    [Parameter(Position=0)]
    [ValidateSet("dev","build","test","clean")]
    [string]$Action = "dev"
)

$ErrorActionPreference = "Stop"

# --- 定位项目根目录 ---
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Resolve-Path "$ScriptDir/.."
Set-Location $ProjectRoot

$PlatformLabel = "Windows ($env:PROCESSOR_ARCHITECTURE)"

# --- 前置检查 ---
function Test-Command($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

if (-not (Test-Command "cargo")) {
    Write-Host "❌ 未找到 cargo，请安装 Rust: https://rustup.rs" -ForegroundColor Red
    exit 1
}
if (-not (Test-Command "node")) {
    Write-Host "❌ 未找到 node，请安装 Node.js: https://nodejs.org" -ForegroundColor Red
    exit 1
}

# --- 命令处理 ---
switch ($Action) {
    "dev" {
        Write-Host "🚀 启动开发服务器 ($PlatformLabel)..." -ForegroundColor Green
        npm run tauri -- dev
    }
    "build" {
        Write-Host "📦 编译生产版本 ($PlatformLabel)..." -ForegroundColor Green
        npm run build
        Set-Location src-tauri; cargo build --release; Set-Location ..
        Write-Host "✅ 编译完成: src-tauri\target\release\agentaura-pet-desktop.exe" -ForegroundColor Green
    }
    "test" {
        Write-Host "🧪 运行测试 ($PlatformLabel)..." -ForegroundColor Green
        Write-Host "  前端测试..."
        npm test
        Write-Host "  后端测试..."
        Set-Location src-tauri; cargo test; Set-Location ..
        Write-Host "✅ 所有测试通过" -ForegroundColor Green
    }
    "clean" {
        Write-Host "🧹 清理编译缓存 ($PlatformLabel)..." -ForegroundColor Green
        Set-Location src-tauri; cargo clean; Set-Location ..
        if (Test-Path node_modules/.vite) { Remove-Item -Recurse -Force node_modules/.vite }
        Write-Host "✅ 清理完成" -ForegroundColor Green
    }
}
