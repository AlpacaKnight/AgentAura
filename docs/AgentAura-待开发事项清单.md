# AgentAura 待开发事项清单

## 1. 文档状态

- 状态：待开发
- 上次更新：2026-07-16
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
| Hook 事件数 | **18** | 15 | 10 | 12 | 7 |
| 气泡事件数 | 5 | 5 | 4 | **6** | 5 |
| 任务完成气泡 | ✅ | ✅ | ✅ | ✅ | ✅ |
| Session ID | ✅ | ✅ | ✅ | ✅ | ✅ |
| 心跳循环 | ✅ | ✅ | ✅ | ✅ | ✅ |
| Idle fallback | ❌ | ❌ | ✅ | ❌ | ❌ |
| Hook 抑制 | ✅ | ❌ | ❌ | ❌ | ✅ |
| PetDesktop 管理安装 | ❌ | ✅ | ✅ | ✅ | ❌ |
| 残留调试日志 | ❌ | ❌ | ❌ | ❌ | ❌ |

### 3.1 Hook 事件覆盖矩阵

| 事件 | Claude | Kimi | Codex | Qwen | ZCode |
|------|:------:|:----:|:-----:|:----:|:-----:|
| SessionStart | ✅ | ✅ | ✅ | ✅ | ✅ |
| UserPromptSubmit | ✅ | ✅ | ✅ | ✅ | ✅ |
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
| Stop | ✅ | ✅ | ✅ | ✅ | ✅ |
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
| Stop → "任务已完成" | ✅ | ✅ | ✅ | ✅ | ✅ |
| SessionEnd → "任务已完成" | ❌ | ❌ | ❌ | ✅ | ❌ |

### 3.3 sendMessage / sendAgentState 签名（已统一 ✅）

五个插件现均使用统一签名 `sendMessage(text, kind, priority?, ttlMs?, context?)` 与 `sendAgentState(state, context?)`，context 始终位于末尾并贯穿 HTTP / command 两条路径（含 firmware 上报与 404 重注册）。

| 插件 | 签名 | context 位置 |
|------|------|-------------|
| Claude | `sendMessage(text, kind, priority?, ttlMs?, context?)` | 最后 |
| Codex | `sendMessage(text, kind, priority?, ttlMs?, context?)` | 最后 |
| Kimi | `sendMessage(text, kind, priority?, ttlMs?, context?)` | 最后 |
| Qwen | `sendMessage(text, kind, priority?, ttlMs?, context?)` | 最后 |
| ZCode | `sendMessage(text, kind, priority?, ttlMs?, context?)` | 最后 |

---

## 4. 待开发事项

### 4.1 高优先级 — 插件一致性

#### 4.1.1 统一 sendMessage / sendAgentState 签名

> ✅ 已完成（2026-07-16）：五个插件的 `sendMessage` 已统一为 `sendMessage(text, kind, priority?, ttlMs?, context?)`，`sendAgentState` 统一为 `sendAgentState(state, context?)`；Claude/Codex 补齐 context 参数，Qwen/ZCode 将 context 由第二位调整到末尾，并修复 firmware/command 路径此前未透传 session 头的问题。

- **目标**：统一为 `sendMessage(text, kind, priority?, ttlMs?, context?)` 和 `sendAgentState(state, context?)`
- **范围**：Claude、Codex 缺 context 参数；Kimi 的 context 在末尾（已符合目标）；Qwen/ZCode 的 context 在第二位需调整
- **影响文件**：
  - `Agent_Plugin/agent-aura-claude/src/deviceClient.ts`
  - `Agent_Plugin/agent-aura-codex/src/deviceClient.ts`
  - `Agent_Plugin/agent-aura-qwencode/src/deviceClient.ts`
  - `Agent_Plugin/agent-aura-zcode/src/deviceClient.ts`
  - 各插件 `hooks.ts` 中的调用处

#### 4.1.2 为 Claude / Codex 补 Session ID 支持

> ✅ 已完成（2026-07-16）：Claude 与 Codex 均已实现 `extractSessionId`、`SendContext` 透传、`httpHeaders()` 的 `x-agentaura-session` 头，并将 session 持久化到 runtime（Claude 复用 index signature，Codex 在 `RuntimeState` 新增 `lastSessionId`），HTTP / command 两条路径均带上该头。

- **问题**：Claude 和 Codex 不提取 session ID，不发送 `x-agentaura-session` 头，服务端无法在 session 切换时清空旧气泡（`core.rs:210-216`）
- **目标**：在 `hooks.ts` 中添加 `extractSessionId`，在 `deviceClient.ts` 的 `httpHeaders()` 中添加 `x-agentaura-session` 头
- **参考**：Kimi `hooks.ts:215-222`、`deviceClient.ts:563-578`

#### 4.1.3 统一气泡事件覆盖 — 补"任务完成"气泡

> ✅ 已完成（2026-07-16）：Claude、Kimi、Codex 的 `buildXxxMessage` 均已补 `Stop` → `{ text: "任务已完成", kind: 'success' }` 分支，五个插件现已全部支持"任务已完成"气泡。

- **问题**：Claude、Kimi、Codex 在 `Stop` 时不发"任务已完成"气泡，Qwen/ZCode 发
- **目标**：在各插件的 `buildXxxMessage` 中添加 `Stop` 分支 → `{ text: "任务已完成", kind: 'success' }`
- **影响文件**：
  - `agent-aura-claude/src/hooks.ts` → `buildClaudeMessage`
  - `agent-aura-kimi-code/src/hooks.ts` → `buildKimiMessage`
  - `agent-aura-codex/src/hooks.ts` → `buildCodexMessage`

#### 4.1.4 为 Codex 补 PostToolUseFailure 事件

> ✅ 已完成（2026-07-16）：已补官方支持的 `UserPromptSubmit` 事件（映射为 `running`），`CODEX_HOOK_EVENTS` 现覆盖官方全部 10 个事件。经查证 Codex CLI 官方文档（config-reference），`PostToolUseFailure`、`StopFailure`、`SessionEnd` **不在官方支持的 hook 事件列表中**——官方仅支持 10 个事件：SessionStart、UserPromptSubmit、PreToolUse、PermissionRequest、PostToolUse、PreCompact、PostCompact、SubagentStart、SubagentStop、Stop。故不纳入 `CODEX_HOOK_EVENTS`，避免安装 Codex 不会触发的无效 hook。工具失败已由 `PostToolUse` + `payloadSignalsError` 覆盖，无需 `PostToolUseFailure`。

- **问题**：`CODEX_HOOK_EVENTS` 缺 `UserPromptSubmit`（官方支持）
- **目标**：补 `UserPromptSubmit` 事件；`PostToolUseFailure`/`StopFailure`/`SessionEnd` 经查证非官方事件，不纳入
- **影响文件**：`agent-aura-codex/src/hooks.ts`、`agent-aura-codex/test/regression.test.js`

### 4.2 高优先级 — PetDesktop 插件管理

#### 4.2.1 实现 Claude PetDesktop 自动安装

- **问题**：`PetDesktop/src-tauri/src/plugins/process.rs:934` 返回 `"Claude marketplace 自动安装尚未实现"`
- **目标**：实现 Claude 插件的 PetDesktop 托管安装逻辑
- **影响文件**：`PetDesktop/src-tauri/src/plugins/process.rs`

> 说明：ZCode 和 Claude 均从插件包自动加载 `hooks/hooks.json`（通过 `${ZCODE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_ROOT}` 变量），无需手动编辑配置文件。真正需要配置文件编辑的只有 Codex、Kimi、Qwen 三个插件，已正确在 `hooks()` 中。PetDesktop 无需为 ZCode/Claude 管理 Hooks。

### 4.3 中优先级 — 代码质量

#### 4.3.1 清理 Qwen / ZCode 残留调试日志

> ✅ 已完成（2026-07-16）：Qwen 和 ZCode 的 `hooks.ts` 中 3 处 `process.stderr.write` 已删除，catch 块改为空 `catch {}`，与 Claude/Kimi/Codex 一致。

- **问题**：Qwen `hooks.ts:48,51,77` 和 ZCode `hooks.ts:45,48,58` 每次 hook 触发都写 stderr
- **目标**：移除或改为受 `debugEnabled()` 控制
- **影响文件**：
  - `agent-aura-qwencode/src/hooks.ts`
  - `agent-aura-zcode/src/hooks.ts`

#### 4.3.2 修复 ZCode Hook 抑制死代码

> ✅ 已完成（2026-07-16）：`shouldSkipZcodeHook` 已参照 Claude 的 `shouldSkipClaudeHook` 重写：检测到 slash 命令时调用 `suppressHooks()`，SessionStart/UserPromptSubmit 时调用 `clearHookSuppression()`，并检查 `hooksSuppressed()` 实现时间窗口抑制。import 已补充三个抑制函数。

- **问题**：ZCode 的 `config.ts` 定义了 `suppressHooks`/`clearHookSuppression`/`hooksSuppressed`，`index.ts` 调用了 `suppressHooks()`，但 `shouldSkipZcodeHook`（`hooks.ts:62-70`）从不读取 `hooksSuppressed()`，两个分支都 `return false`
- **目标**：参照 Claude 的 `shouldSkipClaudeHook`（`hooks.ts:74-87`），在 `shouldSkipZcodeHook` 中加入 `hooksSuppressed()` 检查
- **影响文件**：`agent-aura-zcode/src/hooks.ts`

#### 4.3.3 修复 Claude build 脚本异常

> ✅ 已完成（2026-07-16）：Claude 新增 `"package": "bash scripts/build.sh --pack"`；`"build"` 保持为 `"npm test"`，因此构建流程会编译并运行回归测试。

- **问题**：Claude 的打包脚本需要复用 `build.sh --pack`，同时构建不能跳过回归测试
- **目标**：保留 `"build": "npm test"` 并添加 `"package": "bash scripts/build.sh --pack"`
- **影响文件**：`Agent_Plugin/agent-aura-claude/package.json`

#### 4.3.4 插件版本对齐

> ✅ 已完成（2026-07-16）：Claude 和 Kimi 的 `version` 从 `0.1.0` 升至 `0.3.0`，与 Codex、Qwen、ZCode 对齐。

- **问题**：Claude `0.1.0`、Kimi `0.1.0` 落后；Codex、Qwen、ZCode 已是 `0.3.0`
- **目标**：Claude 和 Kimi 升版本至 `0.3.0`
- **影响文件**：`agent-aura-claude/package.json`、`agent-aura-kimi-code/package.json`

### 4.4 中优先级 — CI / 测试

#### 4.4.1 Qwen Code 接入 CI

> ✅ 已完成（2026-07-16）：`agent-aura-qwencode` 已加入 `.github/workflows/petdesktop.yml` plugins job，执行 `npm ci && npm test`。

- **问题**：`agent-aura-qwencode` 完全不在 `.github/workflows/petdesktop.yml` 的 plugins job 中
- **目标**：添加 `npm ci && npm test` 步骤
- **影响文件**：`.github/workflows/petdesktop.yml`

#### 4.4.2 Kimi / ZCode / Copilot 在 CI 中启用测试

> ✅ 已完成（2026-07-16）：Kimi 和 ZCode 的 CI 步骤从 `npm run compile` 改为 `npm test`。Copilot 保持 `npm run compile`（无测试文件）。

- **问题**：CI 对 Kimi/ZCode/Copilot 只运行 `npm run compile`，跳过 `npm test`
- **目标**：改为 `npm ci && npm test`（Copilot 除外，无测试文件）
- **影响文件**：`.github/workflows/petdesktop.yml`

#### 4.4.3 补充气泡消息单元测试

> ✅ 已完成（2026-07-16）：五个插件的 `buildXxxMessage` 均已添加单元测试，覆盖 PreToolUse/PermissionRequest/PostToolUse(成功+失败+错误摘要)/PostToolUseFailure/Stop/SessionEnd(Qwen)/无工具名/未知事件/eventName trim 等场景。测试总数从 51 增至 60，全部通过。

- **问题**：`buildClaudeMessage`、`buildKimiMessage` 等气泡消息构建函数未被直接测试
- **目标**：为各插件的 `buildXxxMessage` 添加回归测试
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

#### 4.5.3 启用 Codex 宠物 v2 新增动画

- **背景**：提交 `d11a392`（`feat: 支持codex宠物v2图集`）为精灵图新增了两个动画行 `look`（row 9，8 帧）和 `directions`（row 10，8 帧），并将 `idle` 扩展到 7 帧。v2 精灵图为 8×11 布局（v1 为 8×9）。
- **问题**：`Pet.tsx:21-30` 的 `STATE_ANIMATION` 映射表中没有任何 `AgentState` 指向 `look` 或 `directions`，两个新动画行处于孤立状态，永远不会被触发。
- **说明**：新增的 `look` / `directions` 是**行为动画**而非状态动画，不属于 `AgentState` 枚举（`init/running/busy/waiting/error/idle/offline/upgrade` 8 个值未变）。插件无需改动——它们仍发送原有的 8 个状态值，PetDesktop 的 `AgentState::from_str` 也只接受这 8 个值。需要做的是在 PetDesktop 前端决定何时触发这两个动画。
- **可能的触发方案**（需确认产品意图）：
  - `look`：Agent 处于 `idle` 状态时以一定概率随机播放（原地张望），增加生动感
  - `directions`：拖拽宠物或闲逛换方向时播放（方向指示），作为过渡动画
- **相关状态**：
  - v1 兼容：`Pet.tsx:65-71` 已有回退保护，`fallbackAnimation.row < petRows`，避免 v1 精灵图渲染越界
  - 验证：`pets.rs:172-176` 已根据 `spriteVersion` 区分 v1（9 行）/ v2（11 行）
  - 配置：`model.rs:163-164` 新增 `sprite_version` 字段，`model.rs:347-380` 的 `default_animations` 在 v2 时追加 `look`/`directions`
- **目标**：确定 `look`/`directions` 的触发条件并实现，让 v2 精灵图的两个新动画行不再孤立
- **影响文件**：`PetDesktop/src/Pet.tsx`（`STATE_ANIMATION` 映射或动画调度逻辑）、`PetDesktop/src/Pet.test.ts`（补充 v2 动画测试）

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

#### 4.7.1 更新 README 插件状态表

> ✅ 已完成（2026-07-16）：Root `README.md` 插件状态表已新增"气泡"列，标注各插件的气泡支持状态（Claude/Codex/Kimi/Qwen/ZCode ✅，QwenPaw/Copilot ❌）。Codex 事件列已更新为"官方 10 事件"。

- **问题**：Root `README.md` 插件状态表未反映气泡支持情况
- **目标**：在状态列中标注气泡支持（如新增"气泡"列）
- **影响文件**：`README.md`

#### 4.7.2 AMOLED 固件 API 文档

> ✅ 已完成（2026-07-16）：新增 `Arduino_ESP32_AMOLED_Pet/doc/API.md`，涵盖文本指令集、JSON 指令协议（state_sync / approval_request / approval_response）、USB 串口、HTTP REST API、WiFi AP 配网、BLE GATT 服务、统一状态 JSON、状态枚举、构建与烧录、已知限制，共 11 节。

- **问题**：AMOLED 固件只有构建指南，无协议/API 文档（RingLight 有 `doc/API.md`）
- **目标**：编写 AMOLED 通信协议文档
- **影响文件**：`Arduino_ESP32_AMOLED_Pet/doc/API.md`

---

## 5. 建议开发顺序

| 顺序 | 事项 | 工作量 | 依赖 | 状态 |
|:----:|------|:------:|:----:|:----:|
| 1 | 统一 sendMessage / sendAgentState 签名 | 中 | 无 | ✅ 已完成 |
| 2 | Claude / Codex 补 Session ID 支持 | 小 | #1 | ✅ 已完成 |
| 3 | 统一气泡事件覆盖（补"任务完成"气泡） | 小 | 无 | ✅ 已完成 |
| 4 | Codex 补 UserPromptSubmit（官方 10 事件对齐） | 小 | 无 | ✅ 已完成 |
| 5 | 清理 Qwen / ZCode 调试日志 | 极小 | 无 | ✅ 已完成 |
| 6 | 修复 ZCode Hook 抑制死代码 | 极小 | 无 | ✅ 已完成 |
| 7 | 修复 Claude build 脚本 + 版本对齐 0.3.0 | 极小 | 无 | ✅ 已完成 |
| 8 | Qwen 接入 CI + Kimi/ZCode 启用测试 | 小 | 无 | ✅ 已完成 |
| 9 | 补充气泡消息单元测试 | 中 | #1, #2 | ✅ 已完成 |
| 10 | 实现 Claude PetDesktop 自动安装 | 中 | 无 | 暂不做 |
| 12 | 启用 Codex 宠物 v2 新增动画（look/directions） | 中 | 产品确认触发方案 | 暂不做 |
| 13 | 更新过时文档 | 小 | #1-#7 | ✅ 已完成 |
| 14 | （长期）气泡持久化 | 大 | 无 | 待开发 |
| 15 | （长期）多 Agent 气泡展示 | 大 | 无 | 待开发 |
| 16 | （长期）修复 ESP32 BLE | 中 | 硬件调试 | 待开发 |
| 17 | （长期）AMOLED Apps 页面 | 中 | 无 | 待开发 |
| 18 | （长期）三平台 CI 产物验证 | 中 | 无 | 待开发 |

> 进度更新（2026-07-16）：
> - #1 统一签名、#2 Session ID、#3 任务完成气泡 已完成
> - #4 Codex 补 `UserPromptSubmit`，覆盖官方全部 10 个事件已完成；`PostToolUseFailure`/`StopFailure`/`SessionEnd` 经查证非官方 Codex 事件，不纳入
> - #5 清理 Qwen/ZCode 调试日志 已完成
> - #6 修复 ZCode Hook 抑制死代码 已完成
> - #7 修复 Claude build 脚本 + 版本对齐 0.3.0 已完成
> - #8 Qwen 接入 CI + Kimi/ZCode 启用测试 已完成（Copilot 除外，无测试文件）
> - #9 五插件 `buildXxxMessage` 单元测试 已完成（测试总数 51→60，全部通过）
> - #10 Claude 自动安装、#12 v2 动画 用户确认暂不做
> - #13 README 气泡列 + AMOLED API 文档 已完成
> - 剩余：#14-#18 长期项（气泡持久化、多 Agent 展示、ESP32 BLE、AMOLED Apps、三平台 CI）

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
