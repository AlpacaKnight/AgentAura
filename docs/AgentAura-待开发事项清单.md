# AgentAura 待开发事项清单

## 1. 文档状态

- 状态：待开发
- 上次更新：2026-07-15
- 涵盖范围：AgentAura 全项目（PetDesktop、Agent 插件、ESP32 固件、CI/CD、文档）

## 2. 桌宠文字气泡闭环状态

核心气泡链路已 100% 闭环，五个 TS 插件（Claude、Kimi、Codex、Qwen、ZCode）均已接入：

```
Agent 生命周期事件
  → 插件 Hook 脚本 (node out/index.js hook <Event>)
  → sendAgentState → PetDesktop 注册 + 心跳子进程
  → sendMessage → POST /api/v1/agents/{id}/message
  → PetDesktop Rust 后端 (core.submit_message) 入队 + 广播
  → Tauri 事件 "snapshot-changed"
  → React PetBubble 组件渲染气泡
```

| 环节 | 状态 | 关键代码 |
|------|------|----------|
| Hook 脚本入口 | ✅ | 各插件 `index.ts` 的 `hook` 分支 |
| 事件→状态映射 | ✅ | 各插件 `hooks.ts` 的 `mapXxxEventToAgentState` |
| PetDesktop 注册 | ✅ | 各插件 `deviceClient.ts` 的 `registerPetDesktop` |
| 心跳子进程 | ✅ | 各插件 `deviceClient.ts` 的 `ensureHeartbeatProcess` |
| 气泡消息构建 | ✅ | 各插件 `hooks.ts` 的 `buildXxxMessage` |
| 气泡消息发送 | ✅ | 各插件 `deviceClient.ts` 的 `sendMessage` |
| 后端接收+存储 | ✅ | `core.rs:407-495` `submit_message` |
| Tauri 事件推送 | ✅ | `core.rs:180-184` `broadcast()` |
| 前端渲染 | ✅ | `PetBubble.tsx:32-61` `selectBubbleMessage` |

---

## 3. 插件功能对齐总览

| 特性 | Claude | Kimi | Codex | Qwen | ZCode |
|------|:------:|:----:|:-----:|:----:|:-----:|
| Hook 事件数 | **18** | 15 | 8 | 12 | 7 |
| 气泡事件数 | 4 | 4 | 3 | **6** | 5 |
| 任务完成气泡 | ❌ | ❌ | ❌ | ✅ | ✅ |
| Session ID | ❌ | ✅ | ❌ | ✅ | ✅ |
| 心跳循环 | ✅ | ✅ | ✅ | ✅ | ✅ |
| Idle fallback | ❌ | ❌ | ✅ | ❌ | ❌ |
| Hook 抑制 | ✅ | ❌ | ❌ | ❌ | ⚠️ 死代码 |
| PetDesktop 管理安装 | ❌ | ✅ | ✅ | ✅ | ❌ |
| 残留调试日志 | ❌ | ❌ | ❌ | ⚠️ | ⚠️ |

### 3.1 Hook 事件覆盖矩阵

| 事件 | Claude | Kimi | Codex | Qwen | ZCode |
|------|:------:|:----:|:-----:|:----:|:-----:|
| SessionStart | ✅ | ✅ | ✅ | ✅ | ✅ |
| UserPromptSubmit | ✅ | ✅ | ❌ | ✅ | ✅ |
| PreToolUse | ✅ | ✅ | ✅ | ✅ | ✅ |
| PermissionRequest | ✅ | ✅ | ✅ | ✅ | ✅ |
| PermissionDenied | ✅ | ❌ | ❌ | ❌ | ❌ |
| PermissionResult | ❌ | ✅ | ❌ | ❌ | ❌ |
| PostToolUse | ✅ | ✅ | ✅ | ✅ | ✅ |
| PostToolUseFailure | ✅ | ✅ | ❌ | ✅ | ✅ |
| PostToolBatch | ✅ | ❌ | ❌ | ❌ | ❌ |
| Notification | ✅ | ❌ | ❌ | ✅ | ❌ |
| SubagentStart | ✅ | ✅ | ✅ | ✅ | ❌ |
| SubagentStop | ✅ | ✅ | ✅ | ✅ | ❌ |
| TaskCreated | ✅ | ❌ | ❌ | ❌ | ❌ |
| TaskCompleted | ✅ | ❌ | ❌ | ❌ | ❌ |
| PreCompact | ✅ | ✅ | ✅ | ✅ | ❌ |
| PostCompact | ✅ | ✅ | ✅ | ❌ | ❌ |
| Stop | ✅ | ✅ | ❌ | ✅ | ✅ |
| StopFailure | ✅ | ✅ | ❌ | ❌ | ❌ |
| Interrupt | ❌ | ✅ | ❌ | ❌ | ❌ |
| SessionEnd | ✅ | ✅ | ❌ | ✅ | ❌ |

### 3.2 气泡消息覆盖矩阵

| 气泡事件 | Claude | Kimi | Codex | Qwen | ZCode |
|----------|:------:|:----:|:-----:|:----:|:-----:|
| PreToolUse → "正在运行 X" | ✅ | ✅ | ✅ | ✅ | ✅ |
| PermissionRequest → "X 等待授权" | ✅ | ✅ | ✅ | ✅ | ✅ |
| PostToolUse (成功) → "X 已完成" | ✅ | ✅ | ✅ | ✅ | ✅ |
| PostToolUse (失败) → 错误摘要 | ✅ | ✅ | ✅ | ✅ | ✅ |
| PostToolUseFailure → "X 执行出错" | ✅ | ✅ | ❌ | ✅ | ✅ |
| Stop → "任务已完成" | ❌ | ❌ | ❌ | ✅ | ✅ |
| SessionEnd → "任务已完成" | ❌ | ❌ | ❌ | ✅ | ❌ |

### 3.3 sendMessage 签名不一致

| 插件 | 签名 | context 位置 |
|------|------|-------------|
| Claude | `sendMessage(text, kind, priority?, ttlMs?)` | 无 |
| Codex | `sendMessage(text, kind, priority?, ttlMs?)` | 无 |
| Kimi | `sendMessage(text, kind, priority?, ttlMs?, context?)` | 最后 |
| Qwen | `sendMessage(text, context?, kind, priority?, ttlMs?)` | 第二 |
| ZCode | `sendMessage(text, context?, kind, priority?, ttlMs?)` | 第二 |

---

## 4. 待开发事项

### 4.1 高优先级 — 插件一致性

#### 4.1.1 统一 sendMessage / sendAgentState 签名

- **目标**：统一为 `sendMessage(text, kind, priority?, ttlMs?, context?)` 和 `sendAgentState(state, context?)`
- **范围**：Claude、Codex 缺 context 参数；Kimi 的 context 在末尾（已符合目标）；Qwen/ZCode 的 context 在第二位需调整
- **影响文件**：
  - `Agent_Plugin/agent-aura-claude/src/deviceClient.ts`
  - `Agent_Plugin/agent-aura-codex/src/deviceClient.ts`
  - `Agent_Plugin/agent-aura-qwencode/src/deviceClient.ts`
  - `Agent_Plugin/agent-aura-zcode/src/deviceClient.ts`
  - 各插件 `hooks.ts` 中的调用处

#### 4.1.2 为 Claude / Codex 补 Session ID 支持

- **问题**：Claude 和 Codex 不提取 session ID，不发送 `x-agentaura-session` 头，服务端无法在 session 切换时清空旧气泡（`core.rs:210-216`）
- **目标**：在 `hooks.ts` 中添加 `extractSessionId`，在 `deviceClient.ts` 的 `httpHeaders()` 中添加 `x-agentaura-session` 头
- **参考**：Kimi `hooks.ts:215-222`、`deviceClient.ts:563-578`

#### 4.1.3 统一气泡事件覆盖 — 补"任务完成"气泡

- **问题**：Claude、Kimi、Codex 在 `Stop` 时不发"任务已完成"气泡，Qwen/ZCode 发
- **目标**：在各插件的 `buildXxxMessage` 中添加 `Stop` 分支 → `{ text: "任务已完成", kind: 'success' }`
- **影响文件**：
  - `agent-aura-claude/src/hooks.ts` → `buildClaudeMessage`
  - `agent-aura-kimi-code/src/hooks.ts` → `buildKimiMessage`
  - `agent-aura-codex/src/hooks.ts` → `buildCodexMessage`

#### 4.1.4 为 Codex 补 PostToolUseFailure 事件

- **问题**：`CODEX_HOOK_EVENTS` 只有 8 个事件，缺 `PostToolUseFailure`、`Stop`、`StopFailure`、`SessionEnd`
- **目标**：在 `CODEX_HOOK_EVENTS` 和 `CODEX_EVENT_TO_AGENT_STATE` 中补充缺失事件
- **影响文件**：`agent-aura-codex/src/hooks.ts`、`agent-aura-codex/src/installHooks.ts`

### 4.2 高优先级 — PetDesktop 插件管理

#### 4.2.1 实现 Claude PetDesktop 自动安装

- **问题**：`PetDesktop/src-tauri/src/plugins/process.rs:934` 返回 `"Claude marketplace 自动安装尚未实现"`
- **目标**：实现 Claude 插件的 PetDesktop 托管安装逻辑
- **影响文件**：`PetDesktop/src-tauri/src/plugins/process.rs`

#### 4.2.2 PetDesktop hooks() 纳入 Claude 和 ZCode

- **问题**：`PetDesktop/src-tauri/src/plugins/model.rs:43-45` 的 `hooks()` 只对 Codex/Kimi/Qwen 返回 true，Claude（18 个事件）和 ZCode（有 `installHooks.ts`）被排除
- **目标**：将 Claude 和 ZCode 纳入 PetDesktop 管理的 Hook 安装/卸载流程
- **影响文件**：`PetDesktop/src-tauri/src/plugins/model.rs`、`PetDesktop/src-tauri/src/plugins/process.rs`

### 4.3 中优先级 — 代码质量

#### 4.3.1 清理 Qwen / ZCode 残留调试日志

- **问题**：Qwen `hooks.ts:48,51,77` 和 ZCode `hooks.ts:45,48,58` 每次 hook 触发都写 stderr
- **目标**：移除或改为受 `debugEnabled()` 控制
- **影响文件**：
  - `agent-aura-qwencode/src/hooks.ts`
  - `agent-aura-zcode/src/hooks.ts`

#### 4.3.2 修复 ZCode Hook 抑制死代码

- **问题**：ZCode 的 `config.ts` 定义了 `suppressHooks`/`clearHookSuppression`/`hooksSuppressed`，`index.ts` 调用了 `suppressHooks()`，但 `shouldSkipZcodeHook`（`hooks.ts:62-70`）从不读取 `hooksSuppressed()`，两个分支都 `return false`
- **目标**：参照 Claude 的 `shouldSkipClaudeHook`（`hooks.ts:74-87`），在 `shouldSkipZcodeHook` 中加入 `hooksSuppressed()` 检查
- **影响文件**：`agent-aura-zcode/src/hooks.ts`

#### 4.3.3 修复 Claude build 脚本异常

- **问题**：Claude `package.json` 的 `"build": "npm test"`，其他插件是 `"build": "npm run compile"`
- **目标**：改为 `"build": "npm run compile"` 并添加 `package` 脚本
- **影响文件**：`Agent_Plugin/agent-aura-claude/package.json`

#### 4.3.4 插件版本对齐

- **问题**：Claude `0.1.0`、Kimi `0.1.0` 落后；Codex、Qwen、ZCode 已是 `0.3.0`
- **目标**：Claude 和 Kimi 升版本至 `0.3.0`
- **影响文件**：`agent-aura-claude/package.json`、`agent-aura-kimi-code/package.json`

### 4.4 中优先级 — CI / 测试

#### 4.4.1 Qwen Code 接入 CI

- **问题**：`agent-aura-qwencode` 完全不在 `.github/workflows/petdesktop.yml` 的 plugins job 中
- **目标**：添加 `npm ci && npm test` 步骤
- **影响文件**：`.github/workflows/petdesktop.yml`

#### 4.4.2 Kimi / ZCode / Copilot 在 CI 中启用测试

- **问题**：CI 对 Kimi/ZCode/Copilot 只运行 `npm run compile`，跳过 `npm test`
- **目标**：改为 `npm ci && npm test`
- **影响文件**：`.github/workflows/petdesktop.yml`

#### 4.4.3 补充气泡消息单元测试

- **问题**：`buildClaudeMessage`、`buildKimiMessage`、`sendMessage`、`runHeartbeatLoop` 未被直接测试
- **目标**：为各插件的 `buildXxxMessage` 和 `sendMessage` 添加回归测试
- **影响文件**：各插件 `test/regression.test.js`

#### 4.4.4 三平台安装包产物验证

- **问题**：PetDesktop README 指出"CI 目前覆盖前端测试、cargo check、Linux cargo test 和插件回归；三平台安装包产物校验"是已知缺口
- **目标**：CI 增加 Windows/macOS 构建验证
- **影响文件**：`.github/workflows/petdesktop.yml`

### 4.5 低优先级 — PetDesktop 功能增强

#### 4.5.1 气泡持久化

- **问题**：`pet_messages` 是内存 `VecDeque`（`core.rs:35`），PetDesktop 重启后全部丢失；`model.rs:122` 注释"第一版不持久化完整正文"
- **目标**：将气泡消息持久化到磁盘，重启后恢复
- **影响文件**：`PetDesktop/src-tauri/src/core.rs`、`PetDesktop/src-tauri/src/model.rs`

#### 4.5.2 多 Agent 气泡展示

- **问题**：`effective_pet_messages`（`core.rs:579-598`）只返回单个"有效 Agent"的消息队列，其他 Agent 气泡存储了但不显示
- **目标**：前端支持多 Agent 气泡切换/轮播/分组展示
- **影响文件**：`PetDesktop/src-tauri/src/core.rs`、`PetDesktop/src/PetBubble.tsx`、`PetDesktop/src/Pet.tsx`

### 4.6 低优先级 — 固件

#### 4.6.1 修复 ESP32 RingLight BLE

- **问题**：`config.h:55` — `#define BLE_ENABLED false // TODO: ESP32-C3 NimBLE 初始化崩溃, 暂时关闭排查`
- **目标**：排查 ESP32-C3 NimBLE 初始化崩溃，恢复 BLE 支持
- **影响文件**：`Arduino_ESP32_RingLight/ESP32_RingLight_Firmware/src/config.h`、`ble_server.cpp`

#### 4.6.2 AMOLED 桌宠 Apps 页面

- **问题**：`ui_manager.cpp:386` — `"Apps (WIP)"` 占位；`main.cpp:80` — `// TODO: 待定功能` 长按未实现
- **目标**：实现 Apps 页面内容和长按功能
- **影响文件**：`Arduino_ESP32_AMOLED_Pet/src/ui/ui_manager.cpp`、`Arduino_ESP32_AMOLED_Pet/src/main.cpp`

#### 4.6.3 固件测试接入 CI

- **问题**：RingLight 有 4 个 Python 测试文件但不在 CI 中运行；AMOLED 无测试
- **目标**：RingLight 测试接入 CI；AMOLED 补充基础测试
- **影响文件**：`.github/workflows/petdesktop.yml` 或新增固件 workflow

### 4.7 低优先级 — 文档

#### 4.7.1 更新气泡开发计划文档

- **问题**：`docs/PetDesktop-桌宠文字气泡开发计划.md:20-21` 仍标注 Claude 0%、Kimi 0%，但二者已 100% 实现
- **目标**：更新为 100%，移除"待完成功能"小节
- **影响文件**：`docs/PetDesktop-桌宠文字气泡开发计划.md`

#### 4.7.2 更新 README 插件状态表

- **问题**：Root `README.md` 插件状态表未反映气泡支持情况
- **目标**：在状态列中标注气泡支持（如新增"气泡"列）
- **影响文件**：`README.md`

#### 4.7.3 AMOLED 固件 API 文档

- **问题**：AMOLED 固件只有构建指南，无协议/API 文档（RingLight 有 `doc/API.md`）
- **目标**：编写 AMOLED 通信协议文档
- **影响文件**：`Arduino_ESP32_AMOLED_Pet/` 新增 `doc/API.md`

---

## 5. 建议开发顺序

| 顺序 | 事项 | 工作量 | 依赖 |
|:----:|------|:------:|:----:|
| 1 | 统一 sendMessage / sendAgentState 签名 | 中 | 无 |
| 2 | Claude / Codex 补 Session ID 支持 | 小 | #1 |
| 3 | 统一气泡事件覆盖（补"任务完成"气泡） | 小 | 无 |
| 4 | Codex 补 PostToolUseFailure / Stop 等事件 | 小 | 无 |
| 5 | 清理 Qwen / ZCode 调试日志 | 极小 | 无 |
| 6 | 修复 ZCode Hook 抑制死代码 | 极小 | 无 |
| 7 | 修复 Claude build 脚本 + 版本对齐 | 极小 | 无 |
| 8 | Qwen 接入 CI + Kimi/ZCode 启用测试 | 小 | 无 |
| 9 | 补充气泡消息单元测试 | 中 | #1, #2 |
| 10 | 实现 Claude PetDesktop 自动安装 | 中 | 无 |
| 11 | PetDesktop hooks() 纳入 Claude/ZCode | 小 | #10 |
| 12 | 更新过时文档 | 小 | #1-#7 |
| 13 | （长期）气泡持久化 | 大 | 无 |
| 14 | （长期）多 Agent 气泡展示 | 大 | 无 |
| 15 | （长期）修复 ESP32 BLE | 中 | 硬件调试 |
| 16 | （长期）AMOLED Apps 页面 | 中 | 无 |
| 17 | （长期）三平台 CI 产物验证 | 中 | 无 |

---

## 6. 不在开发范围

以下明确不在当前开发计划内：

| 项目 | 原因 |
|------|------|
| QwenPaw（Python 插件）气泡支持 | 设计为硬件同步插件，无 Hook 生命周期事件 |
| Copilot 气泡支持 | VS Code 扩展，无原生 Hook，体验不稳定 |
| Codex App 内部宠物消息获取 | Codex 内部 API 不公开，设计明确不依赖 |
| 完整流式回复正文展示 | 第一版不承诺捕获完整对话正文 |
| 自动从互联网下载插件包 | 安全设计决策，不支持 |
