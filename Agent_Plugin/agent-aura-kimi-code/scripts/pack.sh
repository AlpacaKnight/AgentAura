#!/usr/bin/env bash
# Pack agent-aura-kimi-code into installable npm tgz and zip artifacts.
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

echo "=== Creating npm package ==="
npm pack --pack-destination "$OUT_DIR"

VERSION="$(node -p "require('./package.json').version")"
ZIP_PATH="$OUT_DIR/agent-aura-kimi-code-$VERSION.zip"
rm -f "$ZIP_PATH"

STAGING="$(mktemp -d -t agent-aura-kimi-code-pack-XXXXXX)"
trap 'rm -rf "$STAGING"' EXIT

if command -v rsync >/dev/null 2>&1; then
    rsync -a \
        --exclude='/node_modules/' \
        --exclude='/dist/' \
        --exclude='/.git/' \
        --exclude='*.tgz' \
        --exclude='*.zip' \
        ./ "$STAGING/"
else
    find . -type f \
        ! -path './node_modules/*' \
        ! -path './dist/*' \
        ! -path './.git/*' \
        ! -name '*.tgz' \
        ! -name '*.zip' \
        -exec cp --parents {} "$STAGING/" \;
fi

(
    cd "$STAGING"
    if command -v zip >/dev/null 2>&1; then
        zip -qr "$ZIP_PATH" .
    else
        python3 - "$ZIP_PATH" <<'PY'
import os, sys, zipfile
zip_path = sys.argv[1]
with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
    for root, _dirs, files in os.walk("."):
        for name in files:
            full = os.path.join(root, name)
            zf.write(full, os.path.relpath(full, "."))
PY
    fi
)

TGZ="$(ls -1t "$OUT_DIR"/agent-aura-kimi-code-*.tgz | head -1)"
echo ""
echo "Done:"
echo "  $TGZ"
echo "  $ZIP_PATH"
echo ""
echo "Install with:"
echo "  npm install -g \"$TGZ\""
echo "  agent-aura-kimi-code configure --discover"
echo "  agent-aura-kimi-code install-hooks"