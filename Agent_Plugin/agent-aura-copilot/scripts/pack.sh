#!/usr/bin/env bash
# Pack agent-aura-copilot VS Code extension into .vsix
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo "=== Installing dependencies ==="
npm install

# Note: native modules do NOT need electron-rebuild here. serialport v12 relies
# on @serialport/bindings-cpp, which ships N-API prebuilds (stable ABI) that load
# unchanged across the Node/Electron versions VS Code uses.

echo "=== Compiling TypeScript ==="
npm run compile

# 清理旧版本产物，避免版本迭代后残留
rm -f *.vsix

echo "=== Packaging VSIX ==="
npx @vscode/vsce package --allow-missing-repository

VSIX=$(ls -1t *.vsix 2>/dev/null | head -1)
if [ -n "$VSIX" ]; then
    echo ""
    echo "✅ Done: $VSIX"
    echo ""
    echo "Install with:"
    echo "  code --install-extension $VSIX"
else
    echo "❌ Package failed"
    exit 1
fi
