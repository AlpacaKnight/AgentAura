# PetDesktop 桌宠文字气泡开发计划

## 1. 文档状态

- 状态：<span style="color:orange">部分实施</span>
- 整体完成度：约 91%
- 目标版本：后续 PetDesktop 功能版本
- 适用平台：Windows、Linux、macOS
- 涉及模块：`PetDesktop`、AgentAura 各 Agent 插件
- 上次更新：2026-07-10

## 2. 实施进度概览

| 模块 | 完成度 | 说明 |
|:---|:---:|:---|
| PetDesktop 前端（气泡组件/设置/样式） | 100% | PetBubble.tsx、消息队列、设置类型、CSS 已就绪 |
| PetDesktop 后端（API/队列/数据结构） | 100% | server.rs 消息路由、core.rs 队列管理、model.rs 数据结构 |
| agent-aura-codex 插件 | 100% | hooks.ts 中 buildCodexMessage() 已实现 |
| agent-aura-qwencode 插件 | 100% | hooks.ts 中 buildQwenMessage() 已实现 |
| agent-aura-claude 插件 | 0% | 缺失气泡消息生成和发送逻辑 |
| agent-aura-kimi-code 插件 | 0% | 缺失 sendMessage() 及消息生成逻辑 |

### 2.1 已完成功能

- 数据模型（Rust `PetMessage` / TypeScript `PetMessage` 类型定义）
- `PetBubble` React 组件及消息队列、优先级、去重、TTL 逻辑
- `PetBubbleSettings` 配置项（enabled / mode / duration / maxCharacters / fontScale / showSource）
- 气泡 CSS 样式（包含动画、箭头、文本换行）
- Pet.tsx 中集成气泡渲染
- `POST /api/v1/agents/{instance_id}/message` API 路由及鉴权
- Core 层消息队列（保留 20 条、高优先级替换、去重）
- Codex 插件：发送工具开始/完成/授权/失败事件摘要
- Qwen Code 插件：发送工具事件 + 会话结束消息

### 2.2 待完成功能

- Claude 插件：实现气泡消息生成（参考 codex 模式）
- Kimi Code 插件：deviceClient 增加 sendMessage() 方法，实现消息生成

### 2.3 不涉及插件

| 插件 | 原因 |
|:---|---|
| agent-aura-zcode | 通过 ZCode 应用内插件市场安装，hooks 由 ZCode 自动管理，不涉及气泡消息协议 |
| agent-aura-copilot | VS Code 扩展，无 hooks 生命周期，无消息事件摘要 |
| qwenpaw-plugin | 通过 QwenPaw 插件系统安装，无消息事件摘要 |

## 2. 背景与结论

在桌宠上方显示文字气泡，展示状态提示和 Agent Hook 事件摘要。

Codex App 宠物的内部文字实现没有公开扩展接口，因此本项目不依赖 Codex 内部 API，而是在 PetDesktop 现有透明 Tauri 窗口、React 渲染层和 Agent 状态协议之上独立实现相同类型的视觉体验。

第一版明确支持：

- 状态模板文字，例如"正在运行工具""等待授权""任务完成"。
- 插件能从 Hook 事件中提取到的工具名称、错误摘要和阶段信息。
- 多 Agent 来源切换、消息优先级、超时消失和隐私控制。

第一版不承诺：

- 获取 Codex App 内部宠物消息。
- 捕获所有 Agent 的完整流式回复正文。
- 执行来源不明的任意安装脚本或 Shell 命令。
- 自动从互联网下载插件包。

## 3. 已确认产品决策

### 3.1 文字气泡

- 默认展示"状态模板 + Hook 事件摘要"。
- 默认只显示纯文本，不解析 Markdown 或 HTML。
- 默认截断长文本，完整内容可在管理页日志中查看。
- 用户可关闭气泡、仅显示状态、仅显示事件摘要或同时显示。

### 3.2 首批支持插件

- AgentAura Claude
- AgentAura Codex
- AgentAura Copilot
- AgentAura Kimi Code
- AgentAura Qwen Code
- AgentAura QwenPaw

> 注：以上为计划制定时的首批插件列表。后续新增的 AgentAura ZCode 插件因通过 ZCode 应用内插件机制安装，hooks 由 ZCode 自动管理，不涉及此协议，因此不在气泡计划范围内。

## 4. 当前架构基础

PetDesktop 当前已具备：

- React 管理窗口和独立宠物窗口。
- 透明、置顶、可点击穿透的 Tauri Webview 窗口。
- 宠物缩放、拖动、闲逛和多显示器位置管理。
- Rust 后端、Tauri Commands、本地 HTTP Agent API。
- Agent 注册、心跳、状态选择和运行日志。
- 插件管理页面（安装、卸载、配置、Hooks 管理）。

新增能力应沿用现有分层，不把安装命令、配置文件解析或 Hooks 修改逻辑放进 React 层。

## 5. 功能规划

### 5.1 数据模型

Rust 和 TypeScript 使用语义一致的数据结构：

```ts
type PetMessageKind = 'state' | 'activity' | 'success' | 'warning' | 'error';

interface PetMessage {
  id: string;
  agentInstanceId?: string;
  kind: PetMessageKind;
  text: string;
  source: string;
  priority: number;
  createdAt: string;
  ttlMs: number;
}
```

约束：

- 接收文本最大 500 个 Unicode 字符。
- 气泡默认显示最多 140 个字符。
- 禁止 HTML；React 必须以普通文本节点渲染。
- `ttlMs` 限制在 1.5 秒至 30 秒之间。
- 错误和等待消息优先级高于普通活动消息。

### 5.2 设置项

在 `AppSettings` 增加：

```ts
interface PetBubbleSettings {
  enabled: boolean;
  mode: 'state' | 'events' | 'both';
  durationSeconds: number;
  maxCharacters: number;
  fontScale: number;
  showSource: boolean;
}
```

默认值：

- `enabled: true`
- `mode: 'both'`
- `durationSeconds: 5`
- `maxCharacters: 140`
- `fontScale: 1`
- `showSource: false`

### 5.3 状态模板

没有事件摘要时，按状态提供本地化模板：

| 状态 | 默认文字 |
|:---|:---|
| `init` | 正在初始化… |
| `running` | 正在处理任务… |
| `busy` | 正在使用工具… |
| `waiting` | 等待你的确认 |
| `error` | 操作出现错误 |
| `idle` | 任务已完成 |
| `offline` | Agent 已离线 |
| `upgrade` | 正在更新… |

连续相同状态不重复入队；短时间内的状态变化使用去抖规则。

### 5.4 消息队列

- 每个 Agent 保留最多 20 条内存消息。
- 桌宠只显示当前有效 Agent 的消息。
- 高优先级消息可以替换低优先级消息。
- 同内容在短时间内去重。
- Agent 切换时清理已过期消息，并立即显示新 Agent 最近的有效消息。
- 历史消息仅进入运行日志，第一版不持久化完整正文。

### 5.5 Agent 消息协议

新增向后兼容接口：

```text
POST /api/v1/agents/{instance_id}/message
```

请求体：

```json
{
  "kind": "activity",
  "text": "正在运行 cargo test",
  "priority": 20,
  "ttlMs": 5000
}
```

处理规则：

- 必须复用现有 Agent 身份、来源限制和认证逻辑。
- 未注册 Agent 返回明确错误。
- LAN 模式继续遵守现有 Token 验证。
- 旧插件不发送消息时继续正常工作，仅展示状态模板。

### 5.6 插件事件摘要

各插件只发送 Hook 已提供的信息，不读取用户文件或完整对话：

- 工具开始：`正在运行 <tool>`
- 工具完成：`<tool> 已完成`
- 权限请求：`<tool> 等待授权`
- 工具失败：发送经过截断和清理的错误摘要
- 会话结束：`任务已完成`

如果 Hook 不提供工具名称，只发送通用状态模板。

### 5.7 宠物窗口 UI

需要新增：

- `PetBubble` 组件。
- 消息进入/退出动画。
- 文本换行、最大宽度和箭头样式。
- `aria-live="polite"`，但避免高频状态刷屏。

窗口行为需调整：

- 宽度由当前 220 调整为可容纳气泡的逻辑宽度，建议上限 360。
- 高度按气泡内容动态计算。
- 调整窗口尺寸时保持宠物脚底屏幕坐标不变。
- 每次缩放后调用现有 monitor clamp 逻辑。
- 点击穿透开启时，气泡与宠物整体穿透。
- 右键菜单打开时暂停气泡自动消失计时。

### 5.8 气泡验收标准

- 无消息时不影响现有宠物布局和动画。
- 状态变化后 200ms 内显示对应文字。
- 气泡不会被透明窗口裁切。
- 改变气泡高度时宠物脚底位置不移动。
- 多显示器、125%/150%/200% DPI 下位置正确。
- 关闭气泡后不再调整窗口尺寸。
- 文本无法注入 HTML 或脚本。

## 6. 实施阶段

### 6.1 阶段 0：契约与测试基线

- 固化现有 PetDesktop 快照、设置、Agent API 测试。
- 为新数据模型建立 Rust/TypeScript 对照定义。

交付物：接口设计、测试夹具、回归基线。

### 6.2 阶段 1：文字气泡最小闭环

- 增加气泡设置和状态模板。
- 实现 `PetBubble`、消息队列和窗口动态尺寸。
- 完成 DPI、多显示器、点击穿透和位置锚定测试。

交付物：不依赖插件更新即可工作的状态气泡。

### 6.3 阶段 2：Agent 消息协议

- 增加消息 API、Core 队列和 Tauri 事件。
- 增加鉴权、限长、去重和日志脱敏。
- 更新一款插件作为协议样板，建议先 Codex。

交付物：Codex Hook 摘要可显示在桌宠气泡。

### 6.4 阶段 3：其余插件消息摘要

- 将消息协议接入 Claude、Kimi、Qwen Code 和可提供事件信息的其它插件。
- Provider 不支持详细事件时使用状态模板。

交付物：跨 Agent 一致的气泡体验。

### 6.5 阶段 4：发布验收

- Windows 全量端到端测试。
- Linux/macOS 安装命令和配置路径测试。
- 回归桌宠动画、硬件同步、Agent 多实例和打包流程。
- 更新 README、API 文档、故障排查和隐私说明。

交付物：可发布版本和完整文档。

## 7. 测试计划

### 7.1 前端测试

- 气泡队列、优先级、去重和超时。
- 配置表单校验和敏感字段遮罩。

### 7.2 Rust 单元测试

- 配置原子写入、备份和恢复。
- 子进程超时、取消和错误码处理。

### 7.3 集成测试

- 从本地包完成安装、检测、配置、Hooks 安装和卸载闭环。
- 旧版本升级到新版本。
- 安装失败后保留旧版本。
- 缺少外部 CLI 时提供可执行诊断。
- Qwen Code 单包、双包和版本不一致场景。
- PetDesktop 重启后的状态恢复。

### 7.4 平台测试

| 场景 | Windows | Linux | macOS |
|---|---:|---:|---:|
| 文件选择与拖拽 | 必测 | 必测 | 必测 |
| Node 用户级安装 | 必测 | 必测 | 必测 |
| Copilot VSIX | 必测 | 建议 | 建议 |
| Hooks 路径 | 必测 | 必测 | 必测 |
| 气泡 DPI/多屏 | 必测 | 必测 | 必测 |
| 权限失败提示 | 必测 | 必测 | 必测 |

## 8. 风险与缓解

### 8.1 Agent 无完整文本事件

风险：Hook 只提供生命周期状态，没有完整回复正文。

缓解：状态模板作为稳定基线；仅展示插件实际获得的事件摘要，不抓取内部数据库或日志文件。

### 8.2 Provider CLI 差异

风险：不同版本 CLI 的安装命令和输出格式变化。

缓解：Adapter 先做能力探测；命令失败时保留原始日志；无法自动化时降级为引导模式。

### 8.3 全局安装权限

风险：`npm install -g` 在 Linux/macOS 需要额外权限。

缓解：默认使用 PetDesktop 用户级托管目录，不自动使用 sudo。

### 8.4 Hooks 损坏用户配置

风险：错误合并可能破坏已有配置。

缓解：Provider 专用解析器、修改前备份、原子写入、写后解析验证和精确标记删除。

### 8.5 不可信安装包

风险：压缩包路径逃逸、超大解压、伪造 Manifest 或恶意安装脚本。

缓解：限制格式和 Provider、流式预检、路径规范化、大小/数量限制、禁止预检执行、固定命令适配器。

## 9. 预计修改文件

PetDesktop 前端：

```text
PetDesktop/src/App.tsx
PetDesktop/src/Pet.tsx
PetDesktop/src/api.ts
PetDesktop/src/types.ts
PetDesktop/src/styles.css
```

PetDesktop Rust：

```text
PetDesktop/src-tauri/src/lib.rs
PetDesktop/src-tauri/src/model.rs
PetDesktop/src-tauri/src/core.rs
PetDesktop/src-tauri/src/server.rs
```

插件：

```text
Agent_Plugin/agent-aura-codex/src/*
Agent_Plugin/agent-aura-claude/src/*
Agent_Plugin/agent-aura-kimi-code/src/*
Agent_Plugin/agent-aura-qwencode/src/*
```

## 10. 完成定义

全部满足以下条件才视为完成：

- 桌宠气泡可关闭、可配置，并在三平台正常显示。
- 状态模板和至少四款 Hook 插件的事件摘要可工作。
- 原有桌宠动画、硬件同步、多 Agent 和打包测试全部通过。
- Windows、Linux、macOS 验收矩阵完成。
- 用户文档、API 文档和故障排查文档同步更新。