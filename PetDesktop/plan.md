# PetDesktop 实施基线

PetDesktop 采用 Tauri 2、React、TypeScript 与 Rust 实现，覆盖 Windows、macOS、Linux。应用由透明宠物窗口、管理窗口、系统托盘、Rust 状态核心、本地 HTTP/UDP 服务、宠物资源库和硬件桥接组成。

## 已实施范围

- Codex 宠物目录和 ZIP 安装，应用私有 `pets` 目录、格式校验及安全解压。
- `init/running/busy/waiting/idle/error/offline/upgrade` 动画映射。
- 多 Agent 优先级仲裁、同优先级最近更新、手动来源锁定、心跳过期。
- HTTP `47831`、UDP `8888` 兼容接口与 `/api/v1/agents` 扩展接口。
- HTTP、UDP、串口硬件同步；硬件失败不阻断桌宠。
- Copilot、Codex、Claude Code、QwenPaw 插件接入 PetDesktop，同时保留 ESP32 直连兼容。
- 管理页、托盘、位置记忆、随机闲逛、多显示器约束、开机启动设置。

## 状态优先级

`error > waiting > upgrade > busy > running > init > idle > offline`。锁定来源在线时覆盖自动仲裁；来源超过 30 秒未刷新后离线并解除锁定。只有最终状态改变时才向硬件发送新状态。

## 发布门槛

- 前端生产构建和 Vitest 通过。
- Rust 单元测试、`cargo check` 和三平台 CI 通过。
- 四个插件的现有回归测试通过。
- Windows、macOS、Linux 分别完成透明窗口、托盘、开机启动、多显示器及安装包人工验收。
