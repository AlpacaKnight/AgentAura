#!/usr/bin/env bash
# Build, test, and optionally package agent-aura-claude.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CLEAN=false
PACK=false
OUT_DIR="$PROJECT_DIR/dist"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --clean) CLEAN=true ;;
        --pack) PACK=true ;;
        --out-dir)
            shift
            [[ $# -gt 0 ]] || { echo "--out-dir requires a path" >&2; exit 2; }
            OUT_DIR="$1"
            ;;
        -h|--help)
            echo "Usage: bash scripts/build.sh [--clean] [--pack] [--out-dir PATH]"
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

echo "=== Compiling TypeScript and running tests ==="
npm run build

test -f out/index.js
echo "Build complete: $PROJECT_DIR/out/index.js"

if [[ "$PACK" != true ]]; then
    exit 0
fi

mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

echo "=== Creating npm package ==="
npm pack --ignore-scripts --pack-destination "$OUT_DIR"

VERSION="$(node -p "require('./package.json').version")"
ZIP_PATH="$OUT_DIR/agent-aura-claude-$VERSION.zip"
rm -f "$ZIP_PATH"

STAGING="$(mktemp -d -t agent-aura-claude-pack-XXXXXX)"
trap 'rm -rf "$STAGING"' EXIT

while IFS= read -r -d '' file; do
    case "$file" in
        "$PROJECT_DIR/node_modules/"*|"$PROJECT_DIR/dist/"*|"$PROJECT_DIR/.git/"*|"$OUT_DIR/"*) continue ;;
        *.tgz|*.zip) continue ;;
    esac
    rel="${file#"$PROJECT_DIR/"}"
    mkdir -p "$STAGING/$(dirname "$rel")"
    cp "$file" "$STAGING/$rel"
done < <(find "$PROJECT_DIR" -type f -print0)

(
    cd "$STAGING"
    if command -v zip >/dev/null 2>&1; then
        zip -qr "$ZIP_PATH" .
    else
        python3 - "$ZIP_PATH" <<'PY'
import os, sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as zf:
    for root, _dirs, files in os.walk("."):
        for name in files:
            full = os.path.join(root, name)
            zf.write(full, os.path.relpath(full, "."))
PY
    fi
)

TGZ="$(ls -1t "$OUT_DIR"/agent-aura-claude-*.tgz | head -1)"
echo ""
echo "Package complete:"
echo "  $TGZ"
echo "  $ZIP_PATH"
