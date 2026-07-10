# AgentAura

智能体（AI Agent）状态可视化的多端项目 —— 通过 ESP32 物理灯环与 PetDesktop 桌宠程序，将 AI Agent 的实时状态（运行中、忙碌、等待、错误、空闲等）映射为直观的光效与动画反馈。

使用开源硬件做开源插件/固件，希望能给大家提供一个便宜的硬件可视化方案。

---

## 支持的硬件设备

| 设备 | 描述 |
|------|------|
| ESP32-C3 + WS2812B 环形灯 | 24 颗 RGB LED 圆环，支持 BLE + WiFi 共存，通过 HTTP/UDP/串口 接收状态指令 |

<p align="center">
  <img src="docs/ESP32开发板圆形幻彩灯WS2812B圆环.png" width="300" alt="ESP32 圆环灯板">
</p>

---

## 插件说明

本插件的所有功能都是使用 vibe coding 开发的，纯科技、无手搓，除了插件说明这一段，没有一行是手动修改的。有 bug 是正常的，自己写 bug 可能更多，有问题请留言，我会尽量修复。

## 插件状态一览

| 插件 | Agent 平台 | 安装方式 | 状态获取 | Hook 支持 | 配置页 | 状态 |
|------|-----------|----------|----------|-----------|--------|------|
| **agent-aura-qwenpaw** | QwenPaw | PetDesktop 托管 | AgentRunner API | 原生 | ✅ | ✅ 完善 |
| **agent-aura-claude** | Claude Code | Marketplace / 托管 | Hooks + CLI | 原生 | ✅ | ✅ 完善 |
| **agent-aura-codex** | Codex ~/.codex 配置 | 托管 | hooks.json 命令型 | `SessionStart`, `PreToolUse`, `PermissionRequest`, `PostToolUse` | ✅ | ✅ 完善 |
| **agent-aura-kimi-code** | Kimi Code | 托管 | config.toml [[hooks]] | `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `Stop` | ✅ | ✅ 完善 |
| **agent-aura-qwencode** | Qwen Code / ZCode | 托管 + Qwen 扩展 | Hooks + 扩展事件 | 原生 + `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `Stop` | ✅ | ✅ 完善 |
| **agent-aura-copilot** | VS Code Copilot | VSIX 扩展 | Transcript 监听 | 无原生 hook，体验不稳定 | ❌ | ⚠️ 实验性 |

> **备注**：
> - **PetDesktop 托管安装** 指在桌面应用的"插件"面板中一键安装；**外部安装**指通过各平台自带的包管理（npm、VSIX、Marketplace）手动安装。
> - 所有插件均支持 HTTP / UDP / 串口 三种传输方式，且优先连接 PetDesktop 本地桥接服务。

---

## 子模块说明

### PetDesktop — 三平台桌面宠物与硬件桥接

基于 Tauri 2 + React + Rust 的 Windows/macOS/Linux 桌面应用，集成了 **7 个功能面板**：

| 面板 | 功能 |
|------|------|
| **概览** | 活动源、在线 Agents 数、已安装宠物数、服务端口、手动状态测试、硬件同步状态 |
| **Agents** | Agent 实例列表，连接状态、心跳、锁定、状态标签 |
| **插件** | 6 个插件的检测/安装/卸载、Hooks 管理、连接配置，骨架加载 + 异步并发检测 |
| **宠物** | 宠物库管理，安装/删除/选择宠物，雪碧图动画引擎 |
| **硬件** | HTTP/UDP/串口连接配置，局域网发现与串口扫描 |
| **设置** | 桌宠行为（显示/置顶/闲逛/点击穿透/缩放）、桌宠文字气泡（开关/模式/时长/字体/来源）、服务与启动（开机自启/局域网令牌） |
| **日志** | 运行时日志查看，最多保留 500 条 |

桌宠引擎支持精灵图 spritesheet 动画、闲逛漫游、右键交互菜单、桌宠文字气泡（状态模板 + Agent Hook 事件摘要），并优先通过本地服务将 Agent 状态桥接到 ESP32 硬件。

### Agent 插件

| 目录 | 用途 |
|------|------|
| `agent-aura-claude/` | Claude Code marketplace 插件。通过 `hooks/hooks.json` 捕获 `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`Stop` 等生命周期事件，映射为固件状态指令。提供 `/agent-aura-claude:aura` 会话内命令手动控制。 |
| `agent-aura-codex/` | Codex 命令型 hook。通过 `~/.codex/hooks.json` 注册命令型 hook，捕获用户提交、工具执行、权限请求和停止事件，支持 HTTP/UDP/串口传输。提供 CLI 配置、设备发现与手动测试。 |
| `agent-aura-copilot/` | VS Code Copilot 扩展。监听 GitHub Copilot Chat 的 transcript 和 VS Code 终端事件，解析会话生命周期并发送设备指令。**原生无 Hook 接口，稳定性有限，建议抱着实验精神试用。** |
| `agent-aura-kimi-code/` | Kimi Code hook 插件。通过 `~/.kimi-code/config.toml` 的 `[[hooks]]` 机制注册命令型 hook，捕获 `UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`Stop` 事件。兼容 PetDesktop 身份请求头与 Bearer Token。 |
| `agent-aura-qwencode/` | Qwen Code / ZCode 扩展 + 托管双重支持。通过 Qwen 扩展机制与 hooks 文件捕获事件，支持 `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`Stop`。提供 CLI 配置与设备发现。 |
| `qwenpaw-plugin/` | QwenPaw 独立插件。包装 `AgentRunner` 与 `ApprovalService` 获取智能体事件与审批流程状态，支持 HTTP/UDP/串口。通过 PetDesktop 托管安装，提供完整的生命周期状态映射。 |

### Arduino_ESP32_RingLight — 硬件固件

| 子目录 | 用途 |
|--------|------|
| `ESP32_RingLight_Firmware/` | ESP32-C3 固件，驱动 24 颗 WS2812B LED，集成 REST API、UDP 指令、MQTT、BLE GATT、USB CDC 串口、Web 控制面板，支持 `init`/`running`/`busy`/`waiting`/`idle`/`error`/`offline`/`upgrade` 共 15 种灯效与 Agent 状态映射 |
| `ESP32_RingLight_Demo/` | 环形灯演示程序，用于快速验证硬件与通信协议 |

---

## 项目结构

```text
AgentAura/
├── main.py                              # Python 入口（预留）
├── pyproject.toml                       # uv 依赖管理（firmware 组: platformio）
├── README.md                            # 本文件
├── scripts/
│   ├── build.ps1                        # Windows 全量构建脚本
│   └── build.sh                         # Unix 全量构建脚本
├── PetDesktop/                          # 三平台桌面宠物与硬件桥接
├── Agent_Plugin/                        # IDE 插件集合（6 个）
│   ├── agent-aura-claude/               # Claude Code marketplace 插件
│   ├── agent-aura-codex/                # Codex hooks 插件
│   ├── agent-aura-copilot/              # VS Code Copilot 扩展
│   ├── agent-aura-kimi-code/            # Kimi Code hooks 插件
│   ├── agent-aura-qwencode/             # Qwen Code 扩展 + 托管
│   └── qwenpaw-plugin/                  # QwenPaw 插件
├── Arduino_ESP32_RingLight/             # 硬件：ESP32 环形灯
│   ├── ESP32_RingLight_Demo/
│   └── ESP32_RingLight_Firmware/
├── docs/                                # 文档与资源
│   └── ESP32开发板圆形幻彩灯WS2812B圆环.png
└── dist/                                # 构建产物
    ├── plugin/                          # 各插件的安装包（.tgz / .zip / .vsix）
    └── desktop/                         # PetDesktop 安装包（msi / exe / portable.zip）
```

### 目录命名约定

- `Arduino_{MCU}_{硬件类型}/`：硬件子项目，例如 `Arduino_ESP32_RingLight` 表示基于 ESP32 的环形灯。
- `Agent_Plugin/{plugin-name}/`：IDE / Agent CLI 插件，命名统一为 `agent-aura-{平台名}`，例如 `agent-aura-copilot`、`agent-aura-claude`、`agent-aura-kimi-code`、`agent-aura-qwencode`，其中 qwenpaw 因平台名称特殊保留为 `qwenpaw-plugin`。

---

## 开发环境

- **Python ≥ 3.13**：主项目运行。
- **[uv](https://docs.astral.sh/uv/)**：Python 依赖与虚拟环境管理。
- **Rust 工具链**：编译 PetDesktop 后端时所需。
- **Node.js** 20+（推荐 24+）：构建前端与插件时所需。

```bash
# 安装 uv 后同步依赖
uv sync

# 编译固件需要同步 platformio
uv sync --group firmware
```

各子项目可能有额外的依赖与构建工具，请参阅对应目录下的 README。

---

## 许可证

本项目代码可自由用于个人学习和二次开发。