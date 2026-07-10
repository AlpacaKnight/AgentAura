#!/usr/bin/env bash
# Build and package agent-aura-zcode.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PACKAGE_NAME="agent-aura-zcode"
CLEAN=false
OUT_DIR="$PROJECT_DIR/dist"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --clean) CLEAN=true ;;
        --out-dir)
            shift
            [[ $# -gt 0 ]] || { echo "--out-dir requires a path" >&2; exit 2; }
            OUT_DIR="$1"
            ;;
        -h|--help)
            echo "Usage: bash scripts/pack.sh [--clean] [--out-dir PATH]"
            echo ""
            echo "  (default)   Install deps → compile → pack .tgz"
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

# ── Pack .tgz ──────────────────────────────────────────
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

# 清理旧版本产物，避免版本迭代后残留
rm -f "$OUT_DIR"/"$PACKAGE_NAME"-*.tgz
rm -f "$OUT_DIR"/"$PACKAGE_NAME"-*.zip

echo "=== Creating npm package ==="
npm pack --ignore-scripts --pack-destination "$OUT_DIR"

TGZ="$(ls -1t "$OUT_DIR"/"$PACKAGE_NAME"-*.tgz | head -1)"
echo ""
echo "Done:"
echo "  $TGZ"