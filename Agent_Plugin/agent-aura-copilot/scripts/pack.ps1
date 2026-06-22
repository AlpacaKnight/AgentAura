# Pack agent-aura-copilot VS Code extension into .vsix (Windows)
$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectDir

Write-Host "=== Installing dependencies ===" -ForegroundColor Cyan
npm install

Write-Host "=== Compiling TypeScript ===" -ForegroundColor Cyan
npm run compile

Write-Host "=== Packaging VSIX ===" -ForegroundColor Cyan
npx @vscode/vsce package --allow-missing-repository

$vsix = Get-ChildItem -Filter "*.vsix" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($vsix) {
    Write-Host ""
    Write-Host "Done: $($vsix.Name)" -ForegroundColor Green
    Write-Host ""
    Write-Host "Install with:"
    Write-Host "  code --install-extension $($vsix.Name)"
} else {
    Write-Host "Package failed" -ForegroundColor Red
    exit 1
}
