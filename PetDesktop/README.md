# AgentAura PetDesktop

PetDesktop 是 AgentAura 的三平台桌面宠物与硬件桥接器。它接收 Codex、Claude Code、Kimi Code、GitHub Copilot、QwenPaw 的状态，在透明置顶窗口播放桌宠动画，并可将仲裁后的状态同步到 ESP32 环形灯。

## 接口文档

- 接口文档入口：[API.md](API.md)

## 功能

- Tauri 2 + React 桌面应用，目标平台为 Windows、macOS、Linux。
- 八种 Agent 状态及多 Agent 优先级仲裁、来源锁定和 30 秒心跳过期。
- Codex `pet.json + spritesheet.webp` 宠物目录/ZIP 安装，资源复制到应用数据目录。
- 透明桌宠、拖拽、位置记忆、多显示器边界约束、缩放、置顶、点击穿透和随机闲逛。
- 桌宠文字气泡：状态模板 + Agent Hook 事件摘要，可关闭、可配置（模式、时长、字符数、字体缩放、显示来源）。
- 系统托盘、Agent 管理、宠物管理、硬件配置、运行日志。
- HTTP/UDP 固件兼容接口和 Agent 注册/心跳扩展接口。
- HTTP、UDP、USB 串口硬件桥接。

## 当前状态

当前代码已覆盖透明桌宠、管理页、托盘、宠物安装、Agent 仲裁、本地 HTTP/UDP 接口和硬件桥接等主功能。状态优先级为 `error > waiting > upgrade > busy > running > init > idle > offline`；锁定来源在线时优先于自动仲裁，来源超过 30 秒未刷新后会离线并解除锁定，且只有最终状态改变时才向硬件发送新状态。

## 发布状态

当前主功能已经完成，Linux 打包问题已解决，桌宠窗口、托盘、开机启动、多显示器约束、硬件桥接和安装包流程已完成人工确认。

CI 目前覆盖前端测试、`cargo check`、Linux `cargo test` 和插件回归；如果后续需要进一步收紧发布流程，可以再补三平台安装包产物校验。

## 前置依赖

### 通用要求

- **Node.js** 20+（推荐 24+）
- **Rust** 1.77.2+（通过 [rustup](https://rustup.rs) 安装）

### Linux

```bash
# Ubuntu/Debian
sudo apt update
sudo apt install -y \
    build-essential \
    libwebkit2gtk-4.1-dev \
    libgtk-3-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev \
    libsoup-3.0-dev \
    libjavascriptcoregtk-4.1-dev

# Fedora/RHEL
sudo dnf install -y \
    gcc \
    webkit2gtk4.1-devel \
    gtk3-devel \
    libappindicator-gtk3-devel \
    librsvg2-devel \
    libsoup3-devel \
    javascriptcoregtk4.1-devel
```

> **conda 用户注意**：如果系统安装了 Anaconda/Miniconda，conda 的 sysroot 会导致链接错误（`undefined symbol: __libc_csu_fini`）。项目自带的开发脚本会自动从 PATH 中移除 conda 路径并使用系统 gcc，无需手动 `conda deactivate`。

### macOS

```bash
# 安装 Xcode Command Line Tools
xcode-select --install
```

### Windows

- 安装 [Visual Studio Build Tools 2022](https://visualstudio.microsoft.com/visual-cpp-build-tools/)，勾选 **使用 C++ 的桌面开发** 工作负载。
- 安装 [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)（Windows 11 已预装）。

## 开发

### 使用跨平台脚本（推荐）

项目提供跨平台开发脚本，自动处理环境配置：

**Linux / macOS：**

```bash
./scripts/dev.sh          # 启动开发服务器
./scripts/dev.sh dev      # 同上
./scripts/dev.sh build    # 使用 Tauri 打包安装包
./scripts/dev.sh test     # 运行前后端测试
./scripts/dev.sh clean    # 清理编译缓存
```

**Windows (PowerShell)：**

```powershell
.\scripts\dev.ps1           # 启动开发服务器
.\scripts\dev.ps1 dev       # 同上
.\scripts\dev.ps1 build     # 使用 Tauri 打包安装包
.\scripts\dev.ps1 test      # 运行前后端测试
.\scripts\dev.ps1 clean     # 清理编译缓存
```

### 手动操作

如果不使用脚本，也可以手动执行：

```bash
cd PetDesktop
npm install
npm run build          # 前端构建 (tsc + vite)
npm test               # 前端测试 (vitest)
npm run tauri -- dev   # 启动开发服务器
```

Rust 测试与检查：

```bash
cargo test --manifest-path PetDesktop/src-tauri/Cargo.toml
cargo check --manifest-path PetDesktop/src-tauri/Cargo.toml
```

### 生成安装包

```bash
cd PetDesktop
npm run tauri -- build
```

产物位于 `src-tauri/target/release/bundle/`：
- Linux: `.deb` / `.AppImage`
- macOS: `.dmg` / `.app`
- Windows: `.msi` / `.exe`

## 宠物包

导入目录或 ZIP 中必须恰好包含一个 `pet.json`：

```json
{
  "id": "happy-dog",
  "displayName": "Happy Dog",
  "description": "A cheerful coding companion.",
  "spritesheetPath": "spritesheet.webp"
}
```

图集为 8 列 × 9 行 WebP。各行依次为 `idle`、`running-right`、`running-left`、`waving`、`jumping`、`failed`、`waiting`、`running`、`review`。导入器拒绝路径穿越、符号链接、超大压缩包和无效图集。

## 本地接口

默认仅监听本机：

- HTTP：`127.0.0.1:47831`
- UDP：`127.0.0.1:8888`
- 健康检查：`GET /health`
- 兼容状态：`GET /api/state`
- 兼容控制：`POST /api/agent?state=busy`、`POST /api/cmd`
- Agent 注册：`POST /api/v1/agents/register`
- 心跳：`POST /api/v1/agents/{instanceId}/heartbeat`
- 状态：`POST /api/v1/agents/{instanceId}/state`
- 气泡消息：`POST /api/v1/agents/{instanceId}/message`

开启局域网模式后需要重启应用。访问令牌可选：留空时允许局域网客户端直接连接；设置令牌后，HTTP 请求必须携带 `Authorization: Bearer <token>`，UDP 远程命令格式为 `auth <token> <command>`。局域网发现命令始终可匿名调用。

## 插件目标选择

- 已明确配置硬件主机或串口的插件继续直连硬件。
- 网络目标为空且自动发现开启时，插件先探测本机 PetDesktop，再回退到原 ESP32 UDP 发现。
- Copilot 与 QwenPaw 是常驻进程，会注册并每 10 秒发送心跳。
- Codex、Claude Code 与 Kimi Code 使用短生命周期 hook 进程，通过兼容请求头提供稳定实例身份，每次生命周期事件刷新在线状态。
