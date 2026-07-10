#!/usr/bin/env bash
# Pack agent-aura-zcode into an installable npm tgz artifact.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="${1:-$PROJECT_DIR/dist}"

cd "$PROJECT_DIR"

echo "=== Installing dependencies ==="
npm install

echo "=== Compiling TypeScript ==="
npm run compile

mkdir -p "$OUT_DIR"

# 清理旧版本产物，避免版本迭代后残留
rm -f "$OUT_DIR"/agent-aura-zcode-*.tgz

echo "=== Creating npm package ==="
npm pack --pack-destination "$OUT_DIR"

TGZ="$(ls -1t "$OUT_DIR"/agent-aura-zcode-*.tgz | head -1)"
echo ""
echo "Done:"
echo "  $TGZ"
echo ""
echo "Install with:"
echo "  # 1. CLI（供 hooks 和本地排障使用，包含完整插件文件）"
echo "  npm install -g \"$TGZ\""
echo "  # 2. 获取插件路径"
echo "  agent-aura-zcode plugin-path"
echo "  # 3. ZCode 插件：在客户端 Settings → Plugin Management → Discover → '+' 添加 plugin-path 输出的目录"
echo "  #    然后安装 agent-aura-zcode"
echo "  # 4. 配置设备"
echo "  agent-aura-zcode configure --transport http --host 127.0.0.1 --port 47831 --auto-discover false"
