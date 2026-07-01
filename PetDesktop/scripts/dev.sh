#!/usr/bin/env bash
# ============================================================================
# PetDesktop 跨平台开发脚本 (Linux / macOS)
#
# 用法:
#   ./scripts/dev.sh              # 启动开发服务器
#   ./scripts/dev.sh dev          # 同上
#   ./scripts/dev.sh build        # 编译生产版本
#   ./scripts/dev.sh test         # 运行前后端测试
#   ./scripts/dev.sh clean        # 清理编译缓存
#
# 功能:
#   - 自动隔离 conda 环境，避免 sysroot 冲突 (Linux)
#   - macOS 自动使用 clang (Xcode Command Line Tools)
#   - 自动设置 CC/CXX 为系统编译器
# ============================================================================

set -euo pipefail

# --- 定位项目根目录 ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

OS="$(uname -s)"
ARCH="$(uname -m)"

# --- 隔离 conda 环境 ---
# conda 的 sysroot (Scrt1.o) 在 Linux 上引用了不存在的
# __libc_csu_init / __libc_csu_fini 符号，导致链接失败。
# 解决方案: 从 PATH 中移除所有 conda 路径，强制使用系统编译器。

CONDA_DIRS=(
    "/opt/conda"
    "/opt/miniconda3"
    "/opt/miniforge3"
    "$HOME/anaconda3"
    "$HOME/miniconda3"
    "$HOME/miniforge3"
    "$HOME/.conda"
    "$HOME/mambaforge"
    "$HOME/micromamba"
)

clean_conda_from_path() {
    local p="$1"
    for conda_dir in "${CONDA_DIRS[@]}"; do
        p="${p//$conda_dir\/bin:/}"
        p="${p//$conda_dir\/condabin:/}"
        p="${p//$conda_dir\/:/}"
        p="${p//$conda_dir:/}"
    done
    echo "$p"
}

CLEAN_PATH="$(clean_conda_from_path "$PATH")"

# --- 平台特定配置 ---
if [[ "$OS" == "Darwin" ]]; then
    # macOS: 使用 clang (Xcode Command Line Tools)
    export CC="${CC:-clang}"
    export CXX="${CXX:-clang++}"
    export PATH="$CLEAN_PATH"
    PLATFORM_LABEL="macOS ($ARCH)"

elif [[ "$OS" == "Linux" ]]; then
    # Linux: 使用系统 gcc，绕过 conda sysroot
    SYS_GCC="/usr/bin/gcc"
    if [[ ! -x "$SYS_GCC" ]]; then
        SYS_GCC="$(command -v gcc 2>/dev/null || echo "")"
        if [[ -z "$SYS_GCC" ]]; then
            echo "❌ 未找到 gcc"
            echo "   Ubuntu/Debian: sudo apt install build-essential"
            echo "   Fedora/RHEL:   sudo dnf install gcc"
            exit 1
        fi
    fi
    export CC="$SYS_GCC"
    export CXX="${SYS_GCC/gcc/g++}"
    export PATH="$CLEAN_PATH"
    PLATFORM_LABEL="Linux ($ARCH)"

else
    echo "❌ 不支持的系统: $OS"
    echo "   Windows 请使用: powershell -ExecutionPolicy Bypass -File scripts/dev.ps1"
    exit 1
fi

# --- 命令处理 ---
ACTION="${1:-dev}"

run_dev() {
    echo "🚀 启动开发服务器 ($PLATFORM_LABEL)..."
    npm run tauri -- dev
}

run_build() {
    echo "📦 生成安装包 ($PLATFORM_LABEL)..."
    npm run tauri -- build
    echo "✅ 打包完成: src-tauri/target/release/bundle/"
}

run_test() {
    echo "🧪 运行测试 ($PLATFORM_LABEL)..."
    echo "  前端测试..."
    npm test
    echo "  后端测试..."
    cd src-tauri && cargo test && cd ..
    echo "✅ 所有测试通过"
}

run_clean() {
    echo "🧹 清理编译缓存 ($PLATFORM_LABEL)..."
    cd src-tauri && cargo clean && cd ..
    rm -rf node_modules/.vite
    echo "✅ 清理完成"
}

show_help() {
    cat <<EOF
PetDesktop 开发脚本 ($PLATFORM_LABEL)

用法: $0 [dev|build|test|clean]

命令:
  dev     启动开发服务器 (默认)
  build   使用 Tauri 打包安装包
  test    运行前后端测试
  clean   清理编译缓存

环境:
  CC=$CC
  CXX=$CXX
EOF
}

case "$ACTION" in
    dev)             run_dev ;;
    build)           run_build ;;
    test)            run_test ;;
    clean)           run_clean ;;
    help|-h|--help)  show_help ;;
    *)
        echo "❌ 未知命令: $ACTION"
        echo ""
        show_help
        exit 1
        ;;
esac
