#!/usr/bin/env bash
# -*- coding: utf-8 -*-
#
# Pack the agentaura plugin into a versioned .zip.
#
# Builds the frontend bundle first (npm install + vite build -> ../dist/index.js),
# then zips all plugin source files (excluding node_modules / caches).
#
# Usage:
#   bash scripts/pack.sh                  # build frontend + pack
#   bash scripts/pack.sh --skip-frontend  # pack only (dist/index.js must exist)
#   bash scripts/pack.sh /opt/out         # custom output dir
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MANIFEST="$PLUGIN_DIR/plugin.json"
FRONTEND_DIR="$PLUGIN_DIR/ui"

SKIP_FRONTEND=0
OUT_DIR=""
for arg in "$@"; do
    case "$arg" in
        --skip-frontend) SKIP_FRONTEND=1 ;;
        -h|--help)
            echo "Usage: bash scripts/pack.sh [--skip-frontend] [OUT_DIR]"
            exit 0
            ;;
        *) OUT_DIR="$arg" ;;
    esac
done
OUT_DIR="${OUT_DIR:-$PLUGIN_DIR/dist}"

if [[ ! -f "$MANIFEST" ]]; then
    echo "ERROR: plugin.json not found at $MANIFEST" >&2
    exit 1
fi

# --- read version + id from plugin.json ---
read_manifest_field() {
    python3 - "$MANIFEST" "$1" <<'PY'
import json, sys
path, field = sys.argv[1], sys.argv[2]
with open(path, "r", encoding="utf-8") as f:
    data = json.load(f)
print(data.get(field, ""))
PY
}

if ! command -v python3 >/dev/null 2>&1; then
    echo "ERROR: python3 is required to read plugin.json" >&2
    exit 1
fi

VERSION="$(read_manifest_field version)"
PLUGIN_ID="$(read_manifest_field id)"

if [[ -z "$VERSION" ]]; then
    echo "ERROR: plugin.json missing 'version'" >&2
    exit 1
fi
if [[ -z "$PLUGIN_ID" ]]; then
    echo "ERROR: plugin.json missing 'id'" >&2
    exit 1
fi

# --- build frontend bundle ---
if [[ "$SKIP_FRONTEND" -eq 0 && -d "$FRONTEND_DIR" ]]; then
    echo "Building frontend bundle..."
    (
        cd "$FRONTEND_DIR"
        if [[ ! -d node_modules ]]; then
            npm install
        fi
        npm run build
    )
    if [[ ! -f "$PLUGIN_DIR/dist/index.js" ]]; then
        echo "ERROR: frontend build did not produce dist/index.js" >&2
        exit 1
    fi
    echo "Frontend bundle: $PLUGIN_DIR/dist/index.js"
fi

mkdir -p "$OUT_DIR"

ZIP_NAME="${PLUGIN_ID}-${VERSION}.zip"
ZIP_PATH="${OUT_DIR%/}/${ZIP_NAME}"
rm -f "$ZIP_PATH"

# --- build the zip with a staging dir so entries are relative to plugin root ---
STAGING="$(mktemp -d -t agentaura-pack-XXXXXX)"
trap 'rm -rf "$STAGING"' EXIT

(
    cd "$PLUGIN_DIR"
    # Copy everything except dev/build/cache artifacts.
    # NOTE: root dist/ IS included (holds the built index.js), but
    # frontend/dist, ui/node_modules, and the .zip artifact are excluded.
    if command -v rsync >/dev/null 2>&1; then
        rsync -a \
            --exclude='/ui/dist/' \
            --exclude='/ui/node_modules/' \
            --exclude='/node_modules/' \
            --exclude='/__pycache__' \
            --exclude='__pycache__' \
            --exclude='*.pyc' \
            --exclude='*.pyo' \
            --exclude='/.pytest_cache' \
            --exclude='/.mypy_cache' \
            --exclude='/.git' \
            --exclude='/.gitignore' \
            --exclude='/package-lock.json' \
            --exclude='/ui/package-lock.json' \
            --exclude="*.zip" \
            ./ "$STAGING/"
    else
        find . -type f \
            ! -path './ui/dist/*' \
            ! -path './ui/node_modules/*' \
            ! -path './node_modules/*' \
            ! -path '*/__pycache__/*' \
            ! -name '*.pyc' \
            ! -name '*.pyo' \
            ! -path './.pytest_cache/*' \
            ! -path './.mypy_cache/*' \
            ! -path './.git/*' \
            ! -name '.gitignore' \
            ! -name 'package-lock.json' \
            ! -name '*.zip' \
            -exec cp --parents {} "$STAGING/" \;
    fi
)

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
            arc = os.path.relpath(full, ".")
            zf.write(full, arc)
PY
    fi
)

# --- report ---
FILE_COUNT="$(python3 -c "import zipfile,sys; print(len(zipfile.ZipFile(sys.argv[1]).namelist()))" "$ZIP_PATH")"
SIZE="$(stat -f%z "$ZIP_PATH" 2>/dev/null || stat -c%s "$ZIP_PATH")"
echo ""
echo "Packed ${FILE_COUNT} file(s) -> ${ZIP_PATH} ($(printf '%d' "$SIZE") bytes)"
echo ""
echo "Install with:"
echo "  qwenpaw plugin install \"${ZIP_PATH}\""
