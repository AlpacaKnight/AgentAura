#!/usr/bin/env bash
# AgentAura full build script (Linux / macOS)
# Builds all submodules and collects artifacts into a single output directory.
#
# Usage:
#   bash scripts/build.sh                  # build all
#   bash scripts/build.sh --skip-desktop   # skip PetDesktop
#   bash scripts/build.sh --only claude    # build only agent-aura-claude
#   bash scripts/build.sh --out-dir /tmp/out
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="$ROOT_DIR/dist"
SKIP_DESKTOP=false
ONLY=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --skip-desktop) SKIP_DESKTOP=true ;;
        --only)
            shift
            [[ $# -gt 0 ]] || { echo "--only requires a module name" >&2; exit 2; }
            ONLY="$1"
            ;;
        --out-dir)
            shift
            [[ $# -gt 0 ]] || { echo "--out-dir requires a path" >&2; exit 2; }
            OUT_DIR="$1"
            ;;
        -h|--help)
            echo "Usage: bash scripts/build.sh [--skip-desktop] [--only MODULE] [--out-dir PATH]"
            echo ""
            echo "Modules: claude, codex, copilot, kimi-code, qwencode, qwenpaw, zcode, desktop"
            exit 0
            ;;
        *) echo "Unknown argument: $1" >&2; exit 2 ;;
    esac
    shift
done

OUT_DIR="$(mkdir -p "$OUT_DIR" && cd "$OUT_DIR" && pwd)"
FAILED=()

build_module() {
    local name="$1"
    local dir="$2"
    local script="$3"
    shift 3
    local args=("$@")

    if [[ -n "$ONLY" && "$ONLY" != "$name" ]]; then
        return 0
    fi

    local module_out="$OUT_DIR/plugin/$name"
    rm -rf "$module_out"
    mkdir -p "$module_out"

    echo ""
    echo "========================================"
    echo "  Building: $name"
    echo "========================================"

    if ! (cd "$dir" && bash "$script" "${args[@]}"); then
        echo "FAILED: $name" >&2
        FAILED+=("$name")
        return 0
    fi

    # Collect artifacts from dist/ and project root
    for collect_dir in "$dir/dist" "$dir"; do
        [[ -d "$collect_dir" ]] || continue
        cp -f "$collect_dir/"*.tgz "$module_out/" 2>/dev/null || true
        cp -f "$collect_dir/"*.zip "$module_out/" 2>/dev/null || true
        cp -f "$collect_dir/"*.vsix "$module_out/" 2>/dev/null || true
    done

    echo "Artifacts collected: $module_out"
}

# --- Plugins ---
PLUGINS_DIR="$ROOT_DIR/Agent_Plugin"

build_module "claude"   "$PLUGINS_DIR/agent-aura-claude"   "scripts/build.sh"  --pack --out-dir "$PLUGINS_DIR/agent-aura-claude/dist"
build_module "codex"    "$PLUGINS_DIR/agent-aura-codex"    "scripts/pack.sh"   "$PLUGINS_DIR/agent-aura-codex/dist"
build_module "copilot"  "$PLUGINS_DIR/agent-aura-copilot"  "scripts/pack.sh"   "$PLUGINS_DIR/agent-aura-copilot/dist"
build_module "kimi-code" "$PLUGINS_DIR/agent-aura-kimi-code" "scripts/pack.sh" "$PLUGINS_DIR/agent-aura-kimi-code/dist"
build_module "qwencode" "$PLUGINS_DIR/agent-aura-qwencode" "scripts/pack.sh"   "$PLUGINS_DIR/agent-aura-qwencode/dist"
build_module "qwenpaw"  "$PLUGINS_DIR/qwenpaw-plugin"      "scripts/pack.sh"   "$PLUGINS_DIR/qwenpaw-plugin/dist"
build_module "zcode"    "$PLUGINS_DIR/agent-aura-zcode"     "scripts/pack.sh"   --out-dir "$PLUGINS_DIR/agent-aura-zcode/dist"

# --- PetDesktop ---
if [[ "$SKIP_DESKTOP" == false && (-z "$ONLY" || "$ONLY" == "desktop") ]]; then
    echo ""
    echo "========================================"
    echo "  Building: desktop"
    echo "========================================"

    DESKTOP_OUT="$OUT_DIR/desktop"
    rm -rf "$DESKTOP_OUT"
    mkdir -p "$DESKTOP_OUT"

    desktop_failed=false
    if ! (cd "$ROOT_DIR/PetDesktop" && bash scripts/dev.sh build); then
        echo "FAILED: desktop" >&2
        FAILED+=("desktop")
        desktop_failed=true
    fi

    # Collect installers — 每种格式只复制最新的文件，避免旧版本残留
    BUNDLE="$ROOT_DIR/PetDesktop/src-tauri/target/release/bundle"
    collect_latest() {
        local src_dir="$1"
        local pattern="$2"
        [[ -d "$src_dir" ]] || return 0
        local latest
        latest="$(ls -1t "$src_dir"/$pattern 2>/dev/null | head -1)"
        [[ -n "$latest" ]] && cp -f "$latest" "$DESKTOP_OUT/"
    }
    if [[ "$desktop_failed" == false ]]; then
        collect_latest "$BUNDLE/msi" "*.msi"
        collect_latest "$BUNDLE/nsis" "*.exe"
        collect_latest "$BUNDLE/deb" "*.deb"
        collect_latest "$BUNDLE/rpm" "*.rpm"
        collect_latest "$BUNDLE/appimage" "*.AppImage"
        collect_latest "$BUNDLE/AppImage" "*.AppImage"
        collect_latest "$BUNDLE/dmg" "*.dmg"
        collect_latest "$BUNDLE/portable" "*.zip"
    fi

    if [[ "$desktop_failed" == false ]]; then
        echo "Artifacts collected: $DESKTOP_OUT"
    fi
fi

# --- Summary ---
echo ""
echo "========================================"
echo "  Build Summary"
echo "========================================"
echo "Output: $OUT_DIR"
echo ""

for dir in "$OUT_DIR/plugin"/*/ "$OUT_DIR/desktop"/; do
    [[ -d "$dir" ]] || continue
    name="$(basename "$dir")"
    [[ -z "$ONLY" || "$name" == "$ONLY" ]] || continue
    [[ "$SKIP_DESKTOP" == false || "$name" != "desktop" ]] || continue
    count="$(find "$dir" -maxdepth 1 -type f | wc -l)"
    if [[ "$count" -gt 0 ]]; then
        echo "  $name: $count file(s)"
        ls -lh "$dir" | tail -n +2 | awk '{print "    " $NF " (" $5 ")"}'
    else
        echo "  $name: (no artifacts)"
    fi
done

if [[ ${#FAILED[@]} -gt 0 ]]; then
    echo ""
    echo "FAILED modules: ${FAILED[*]}"
    exit 1
fi

echo ""
echo "All builds completed successfully."
