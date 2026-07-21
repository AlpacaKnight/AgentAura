# AgentAura 待开发事项清单

## 1. 文档状态

- 状态：持续维护
- 上次更新：2026-07-21
- 涵盖范围：AgentAura 全项目（PetDesktop、Agent 插件、ESP32 固件、CI/CD、文档）

## 2. 当前未完成事项

### #10 Claude PetDesktop 自动安装

- **状态**：暂不做
- **优先级**：中
- **问题**：`PetDesktop/src-tauri/src/plugins/process.rs` 的 Claude marketplace 自动安装逻辑尚未实现。
- **目标**：未来如需统一插件生命周期，再实现 Claude 插件的 PetDesktop 托管安装。
- **当前决定**：暂不投入开发，保留现有 Claude 插件包安装方式。

### #21 固件测试接入 CI

- **状态**：待开发
- **优先级**：中
- **问题**：RingLight 已有 Python 测试，但尚未接入 CI；AMOLED 尚无对应基础测试覆盖。
- **目标**：
  - 将 `Arduino_ESP32_RingLight/ESP32_RingLight_Firmware/test/` 中的测试接入 CI。
  - 为 AMOLED 固件补充可在 CI 中执行的基础测试。
- **影响范围**：`.github/workflows/petdesktop.yml` 或新增固件专用 workflow，以及对应测试目录。
- **验收标准**：固件测试在 CI 中自动执行，失败时阻断对应 workflow，并保留清晰的测试输出。

## 3. 当前不在开发范围

以下内容已完成、已有明确架构决策，或不属于当前产品范围，不作为待开发事项重复维护：

- Agent 插件气泡事件、状态上报和 PetDesktop HTTP 闭环
- PetDesktop BLE 扫描、连接和 GATT 下发；插件不直连 BLE
- Linux 无关串口过滤
- AMOLED Apps 页面、页面切换和 Boot 长按入口
- ESP32 RingLight BLE 稳定性
- 三平台 CI 编译检查和发布安装包构建
- 气泡正文持久化
- 单桌宠同时展示多个 Agent 气泡
- Codex App 内部私有消息获取
- 完整流式回复正文展示
- 自动从互联网下载插件包

## 4. 状态摘要

当前保留的事项：

1. #10 Claude PetDesktop 自动安装（暂不做）
2. #21 固件测试接入 CI（待开发）
