#!/usr/bin/env bash
# Build and package agent-aura-zcode.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CLEAN=false
OUT_DIR="$PROJECT_DIR/dist"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --clean) CLEAN=true ;;
        --no-pack) PACK=false ;;
        --out-dir)
            shift
            [[ $# -gt 0 ]] || { echo "--out-dir requires a path" >&2; exit 2; }
            OUT_DIR="$1"
            ;;
        -h|--help)
            echo "Usage: bash scripts/build.sh [--clean] [--no-pack] [--out-dir PATH]"
            echo ""
            echo "  (default)   Install deps → compile → pack .tgz"
            echo "  --no-pack   Only compile, skip packing"
            echo "  --clean     Remove out/ before building"
            echo "  --out-dir   Output directory for .tgz (default: dist/)"
            exit 0
            ;;
        *) echo "Unknown argument: $1" >&2; exit 2 ;;
    esac
    shift
done

cd "$PROJECT_DIR"

if [[ "$CLEAN" == true ]]; then
    rm -rf out
fi

echo "=== Installing dependencies ==="
npm install

echo "=== Compiling TypeScript ==="
npm run compile
test -f out/index.js
echo "Build complete: $PROJECT_DIR/out/index.js"

if [[ "${PACK-false}" == false ]]; then
    # --no-pack was passed, skip packaging
    [[ "${PACK+set}" == "set" ]] && exit 0

    # Check whether we should skip default pack
    if [[ "${SKIP_PACK_DEFAULT:-}" == "true" ]]; then
        exit 0
    fi
fi

# ── Pack .tgz ──────────────────────────────────────────
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

# 清理旧版本产物，避免版本迭代后残留
rm -f "$OUT_DIR"/agent-aura-zcode-*.tgz

echo "=== Creating npm package ==="
npm pack --ignore-scripts --pack-destination "$OUT_DIR"

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