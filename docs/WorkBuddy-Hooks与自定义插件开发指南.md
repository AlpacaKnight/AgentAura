# WorkBuddy Hooks 与自定义插件开发指南

> 基于 CodeBuddy Code 引擎，当前 Hooks 处于 **Beta** 阶段

---

## 目录

- [一、Hooks（钩子系统）](#一hooks钩子系统)
  - [1.1 概述](#11-概述)
  - [1.2 支持的事件（27+ 种）](#12-支持的事件27-种)
  - [1.3 Hook 类型](#13-hook-类型)
  - [1.4 配置位置与合并规则](#14-配置位置与合并规则)
  - [1.5 配置格式详解](#15-配置格式详解)
  - [1.6 Matcher 规则](#16-matcher-规则)
  - [1.7 输出控制方式](#17-输出控制方式)
  - [1.8 退出码行为](#18-退出码行为)
  - [1.9 完整配置示例](#19-完整配置示例)
- [二、自定义插件系统](#二自定义插件系统)
  - [2.1 概述](#21-概述)
  - [2.2 插件目录结构](#22-插件目录结构)
  - [2.3 插件清单（plugin.json）](#23-插件清单pluginjson)
  - [2.4 组件详解](#24-组件详解)
  - [2.5 环境变量](#25-环境变量)
  - [2.6 安装作用域](#26-安装作用域)
  - [2.7 CLI 命令参考](#27-cli-命令参考)
  - [2.8 缓存与文件解析](#28-缓存与文件解析)
- [三、独立配置（非插件方式）](#三独立配置非插件方式)
- [四、调试与故障排除](#四调试与故障排除)
- [五、与 Claude Code 兼容性](#五与-claude-code-兼容性)

---

## 一、Hooks（钩子系统）

### 1.1 概述

Hooks 允许在 WorkBuddy 会话的生命周期中插入自定义脚本或命令，实现自动化校验、环境初始化、合规检查等高级能力。

**Hook 的处理流程：**

1. 事件触发
2. 查找所有匹配的 Hook（用户级 + 项目级 + 插件级）
3. 并行执行所有匹配的 Hook
4. 收集执行结果，决定是否放行/阻止

---

### 1.2 支持的事件（27+ 种）

#### 1.2.1 工具生命周期

| 事件 | 触发时机 | 支持 matcher | 典型场景 |
|------|---------|:----------:|---------|
| `PreToolUse` | 工具执行前 | ✅ | 校验命令、二次审批、日志记录 |
| `PostToolUse` | 工具成功执行后 | ✅ | 自动格式化、补充上下文 |
| `PostToolUseFailure` | 工具执行失败后 | ❌ | 错误处理、告警通知 |

#### 1.2.2 会话与子代理

| 事件 | 触发时机 | 说明 |
|------|---------|------|
| `SessionStart` | 会话创建或恢复时 | `matcher`: `startup` / `resume` / `clear` / `compact` |
| `SessionEnd` | 会话结束时 | `reason`: `clear` / `logout` / `prompt_input_exit` / `other` |
| `Stop` | 主代理响应完成时 | 可阻止停止，继续对话 |
| `StopFailure` | 轮次因 API 错误结束时 | 输出和退出码被忽略 |
| `SubagentStart` | 子代理启动时 | 注册子代理级别的 Hook |
| `SubagentStop` | 子代理完成任务时 | 清理子代理资源 |

#### 1.2.3 用户交互

| 事件 | 触发时机 |
|------|---------|
| `UserPromptSubmit` | 用户提交消息时，在 AI 处理之前 |
| `Notification` | 权限请求或 60 秒无输入提醒 |
| `PermissionRequest` | 权限对话框出现时 |
| `PermissionDenied` | 工具调用被自动模式分类器拒绝时 |
| `Elicitation` | MCP 服务器在工具调用期间请求用户输入时 |
| `ElicitationResult` | 用户响应 MCP elicitation 后，响应发回服务器之前 |

#### 1.2.4 上下文管理

| 事件 | 触发时机 |
|------|---------|
| `PreCompact` | 上下文压缩之前 |
| `PostCompact` | 上下文压缩完成后 |
| `InstructionsLoaded` | `CODEBUDDY.md` 或 `.codebuddy/rules/*.md` 加载到上下文时 |
| `ConfigChange` | 会话期间配置文件发生变更时 |

#### 1.2.5 任务与团队

| 事件 | 触发时机 |
|------|---------|
| `TaskCreated` | 通过 `TaskCreate` 创建任务时 |
| `TaskCompleted` | 任务被标记为已完成时 |
| `TeammateIdle` | 团队成员即将进入空闲时 |

#### 1.2.6 文件与环境

| 事件 | 触发时机 |
|------|---------|
| `FileChanged` | 监视的文件的磁盘上变更时。`matcher` 指定要监视的文件名 |
| `CwdChanged` | 工作目录变更时（如 AI 执行 `cd` 命令） |
| `WorktreeCreate` | 通过 `--worktree` 或 `isolation: "worktree"` 创建工作树时 |
| `WorktreeRemove` | 工作树被移除时（会话退出或子代理完成时） |

---

### 1.3 Hook 类型

| 类型 | 说明 | 可用事件 | 适用场景 |
|------|------|---------|---------|
| **`command`** | 执行 Shell 命令或脚本，通过退出码控制流程 | 所有事件 | 快速校验、格式化、日志 |
| **`prompt`** | 使用 LLM 做语义判断/决策 | `Stop`、`UserPromptSubmit`、`PreToolUse` | 智能审批、目标持续追踪 |
| **`agent`** | 启动子代理进行复杂验证 | 所有事件 (frontmatter 专用) | 深度安全检查、多步验证 |
| **`http`** | 发送事件 JSON 到指定 URL | 所有事件 (frontmatter 专用) | 远程通知、集成外部系统 |

#### 1.3.1 Command Hook 详解

**特点：**
- 运行 bash 脚本，快速执行
- 通过**退出码**控制流程
- 支持 `timeout` 配置（默认无超时）

**配置字段：**

```json
{
  "type": "command",
  "command": "python3 /path/to/script.py",
  "timeout": 30
}
```

**退出码行为：**

| 退出码 | 状态 | 行为 |
|:-----:|------|------|
| `0` | 成功 | 继续执行，stdout 内容显示给用户 |
| `2` | 阻塞 | 阻止操作，显示错误消息 |
| 其他 | 非阻塞错误 | 显示警告信息，继续执行 |

**跨平台注意事项：**
- **macOS/Linux**：使用 `$SHELL`（默认 bash/zsh）
- **Windows**：**强制使用 Git Bash**（不支持 cmd.exe/PowerShell）
- **路径引用**：使用 `"$CODEBUDDY_PROJECT_DIR"` 引用项目路径
- **Python 脚本**：显式用 `python3` 调用，避免依赖 shebang

#### 1.3.2 Prompt Hook 详解

**工作原理：**
1. 将 Hook 输入和提示词发送给快速小模型
2. LLM 返回结构化 JSON 决策
3. 自动处理决策结果

**响应格式：**

```json
{
  "ok": true,
  "reason": "解释原因",
  "impossible": false
}
```

**说明：**
- `ok: true` → 允许操作继续
- `ok: false` → 阻止操作，`reason` 说明原因
- `impossible`（仅 `Stop` 事件生效）：设为 `true` 时判定目标无法达成，停止重试

**特有字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `continueOnBlock` | boolean | 设为 `true` 时，条件不满足继续工作（类似 `/goal`） |
| `timeout` | number | 执行超时（秒） |
| `prompt` | string | LLM 提示词，支持 `$ARGUMENTS` 占位符 |

#### 1.3.3 HTTP Hook 详解

将事件 JSON 数据作为 HTTP 请求发送到指定 URL。

```json
{
  "type": "http",
  "url": "https://example.com/webhook",
  "method": "POST"
}
```

**支持的 HTTP 方法：** `POST`、`PUT`、`PATCH`

#### 1.3.4 Agent Hook 详解

使用子代理进行复杂验证任务。

```yaml
# SKILL.md frontmatter
hooks:
  PreToolUse:
    - matcher: Bash
      hooks:
        - type: agent
          agent: security-reviewer
```

---

### 1.4 配置位置与合并规则

#### 4 个配置存储位置

| 作用域 | 文件路径 | 说明 |
|--------|---------|------|
| 用户级 | `~/.codebuddy/settings.json` | 所有项目全局生效 |
| 项目级 | `<项目根>/.codebuddy/settings.json` | 项目成员共享（通过版本控制） |
| 项目本地 | `<项目根>/.codebuddy/settings.local.json` | 本地私有（被 gitignore） |
| 企业策略 | 集成发布的策略文件 | 企业统一管理 |

#### 合并规则

- **不同作用域的 Hooks 会合并**，而非覆盖
- 同一事件的所有匹配 Hooks **并行执行**
- 插件 Hooks 通过 `hooks/hooks.json` 定义，启用时自动合并

#### 合并优先级（从高到低）

```
项目本地 > 项目级 > 用户级 > 企业策略
```

**重要提示：** `settings.json` 中的 Hooks 配置以**最高优先级完整覆盖**较低优先级中相同事件+匹配器的列表，但不同匹配器之间互不影响。

---

### 1.5 配置格式详解

#### 基础结构

```json
{
  "hooks": {
    "EventName": [
      {
        "matcher": "ToolPattern",
        "hooks": [
          {
            "type": "command",
            "command": "your-command",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

#### EventName 完整列表

| 事件名称 | 触发时机 |
|----------|---------|
| `PreToolUse` | 工具执行前 |
| `PostToolUse` | 工具执行成功后 |
| `PostToolUseFailure` | 工具执行失败后 |
| `SessionStart` | 会话启动/恢复 |
| `SessionEnd` | 会话结束 |
| `Stop` | AI 响应完成 |
| `StopFailure` | 轮次因 API 错误结束 |
| `SubagentStart` | 子代理启动 |
| `SubagentStop` | 子代理结束 |
| `UserPromptSubmit` | 用户提交消息 |
| `Notification` | 通知发送 |
| `PermissionRequest` | 权限请求 |
| `PermissionDenied` | 权限拒绝 |
| `Elicitation` | MCP 请求输入 |
| `ElicitationResult` | MCP 输入结果 |
| `PreCompact` | 压缩前 |
| `PostCompact` | 压缩后 |
| `InstructionsLoaded` | 指令加载 |
| `ConfigChange` | 配置变更 |
| `TaskCreated` | 任务创建 |
| `TaskCompleted` | 任务完成 |
| `TeammateIdle` | 成员空闲 |
| `FileChanged` | 文件变更 |
| `CwdChanged` | 目录变更 |
| `WorktreeCreate` | 工作树创建 |
| `WorktreeRemove` | 工作树移除 |

#### Hook 输入 JSON 数据结构

当 Hook 被执行时，事件数据通过标准输入（stdin）以 JSON 格式传入。

**PreToolUse 输入示例：**

```json
{
  "tool_name": "Bash",
  "tool_input": {
    "command": "rm -rf /",
    "description": "Delete everything"
  }
}
```

**PostToolUse 输入示例：**

```json
{
  "tool_name": "Write",
  "tool_input": { "file_path": "/path/to/file.js" },
  "tool_result": "File written successfully"
}
```

**Stop 输入示例：**

```json
{
  "messages": [
    {"role": "assistant", "content": "Task complete..."},
    {"role": "user", "content": "Finish the task"}
  ],
  "subagentResults": [],
  "tokenCount": 5000
}
```

**UserPromptSubmit 输入示例：**

```json
{
  "prompt": "Delete the entire project",
  "fileNames": ["src/index.js", "package.json"]
}
```

**SessionStart 输入示例：**

```json
{
  "startup_reason": "startup",
  "cwd": "/home/user/project",
  "project_dir": "/home/user/project"
}
```

---

### 1.6 Matcher 规则

Matcher 用于在 `PreToolUse` 和 `PostToolUse` 事件中匹配特定的工具名。

| 模式 | 示例 | 匹配结果 |
|------|------|---------|
| 简单匹配 | `Write` | 匹配名称中包含 "Write" 的工具（如 `Write`、`WriteIfNew`） |
| 精确匹配 | `^Write$` | 仅匹配名称为 "Write" 的工具 |
| 多工具匹配 | `Edit\|Write` | 匹配 Edit 或 Write |
| 通配匹配 | `Web.*` | 匹配所有以 Web 开头的工具 |
| 匹配全部 | `*` 或空字符串或省略 | 匹配所有工具 |

**注意：** 匹配器是**大小写敏感**的。

---

### 1.7 输出控制方式

#### 方式一：退出码

| 退出码 | 状态 | 行为 |
|:-----:|------|------|
| `0` | 成功 | 继续执行，stdout 显示给用户 |
| `2` | 阻塞 | 阻止操作，显示错误消息 |
| 其他 | 非阻塞错误 | 显示警告，继续执行 |

#### 方式二：JSON 输出

**退出码 `0` 时的 JSON 输出：**

```json
{
  "continue": true,
  "stopReason": "阻止原因",
  "reason": "原因别名",
  "suppressOutput": false,
  "systemMessage": "用户警告消息",
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow|deny|ask",
    "permissionDecisionReason": "原因说明",
    "modifiedInput": {"field": "new value"},
    "additionalContext": "额外上下文"
  }
}
```

**字段说明：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `continue` | boolean | `false` 等效退出码 2（阻止） |
| `stopReason` | string | 阻止原因 |
| `reason` | string | `stopReason` 的别名 |
| `suppressOutput` | boolean | 是否抑制 stdout 输出 |
| `systemMessage` | string | 显示给用户的警告消息 |
| `modifiedInput` | object | 修改后的输入参数（仅 PreToolUse） |
| `additionalContext` | string | 添加到上下文的额外信息 |

---

### 1.8 退出码行为

#### 退出码 2 在不同事件中的表现

| 事件 | 行为 |
|------|------|
| **PreToolUse** | 阻止工具调用，显示消息给 Agent |
| **PostToolUse** | 显示消息给 Agent（工具已执行完成） |
| **UserPromptSubmit** | 阻止提示词处理，仅显示给用户 |
| **Stop** | 阻止停止，继续对话 |
| **PreCompact** | 阻止压缩，仅显示给用户 |
| **PermissionDenied** | 返回 `{retry: true}` 告知模型可重试 |
| **Notification** | 阻止通知显示 |
| **SessionStart** | 阻止会话启动 |
| **其他事件** | 显示警告，继续执行 |

---

### 1.9 完整配置示例

#### 示例 1：PreToolUse - 命令安全校验

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "python3 /path/to/validate-command.py",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

**validate-command.py 脚本示例：**

```python
#!/usr/bin/env python3
import sys, json

data = json.load(sys.stdin)
command = data["tool_input"]["command"]

# 拒绝危险命令
dangerous = ["rm -rf", "sudo", "shutdown", "format"]
if any(cmd in command for cmd in dangerous):
    print(json.dumps({"continue": False, "stopReason": "危险命令被阻止：" + command}))
    sys.exit(2)  # 阻止操作

# 允许安全命令
sys.exit(0)
```

#### 示例 2：PostToolUse - 代码格式化

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "jq -r '.tool_input.file_path' | xargs -I{} npx prettier --write {} 2>/dev/null || true",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

#### 示例 3：UserPromptSubmit - 敏感信息检查

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "prompt",
            "prompt": "Evaluate if this user prompt is safe and appropriate. Input: $ARGUMENTS\n\nCheck if:\n- Contains sensitive info (passwords, secrets)\n- Request is clear and actionable\n- Any security concerns\n\nReturn JSON: {\"ok\": true} to allow, or {\"ok\": false, \"reason\": \"explanation\"} to block."
          }
        ]
      }
    ]
  }
}
```

#### 示例 4：Stop - 持续工作直到条件满足

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "prompt",
            "prompt": "Check if all tests pass. Context: $ARGUMENTS\nIf yes, {\"ok\": true}. If no, {\"ok\": false, \"reason\": \"what to fix\"}.",
            "continueOnBlock": true,
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

> **注意：** 将 `continueOnBlock` 设为 `true` 且 `ok: false` 时，Agent 会继续工作而不是停止。这实现了类似 `/goal` 的持续追踪效果。

#### 示例 5：SessionStart - 环境初始化

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/setup-environment.sh"
          }
        ]
      }
    ]
  }
}
```

#### 示例 6：MCP 工具 Hook

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "mcp__memory__.*",
        "hooks": [
          {
            "type": "command",
            "command": "echo 'Memory operation logged' >> ~/mcp-operations.log"
          }
        ]
      }
    ]
  }
}
```

#### 示例 7：FileChanged - 文件变更自动处理

```json
{
  "hooks": {
    "FileChanged": [
      {
        "matcher": "*.config.*",
        "hooks": [
          {
            "type": "command",
            "command": "echo 'Config file changed, reloading...'"
          }
        ]
      }
    ]
  }
}
```

#### 示例 8：PermissionDenied - 模型重试提示

```json
{
  "hooks": {
    "PermissionDenied": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "echo '{\"retry\": true}'"
          }
        ]
      }
    ]
  }
}
```

#### 示例 9：综合 - 多事件 Hook 配置

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "\"$CODEBUDDY_PROJECT_DIR\"/.codebuddy/hooks/pre-check.sh",
            "timeout": 10
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "\"$CODEBUDDY_PROJECT_DIR\"/.codebuddy/hooks/check-style.sh"
          }
        ]
      },
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "\"$CODEBUDDY_PROJECT_DIR\"/.codebuddy/hooks/log-command.sh"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          {
            "type": "command",
            "command": "\"$CODEBUDDY_PROJECT_DIR\"/.codebuddy/hooks/setup-env.sh"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "prompt",
            "prompt": "检查所有任务是否已完成。上下文：$ARGUMENTS\n\n如果所有任务完成返回 {\"ok\": true}\n如果还有未完成任务返回 {\"ok\": false, \"reason\": \"还需要完成: ...\"}\n如果目标无法达成返回 {\"ok\": true, \"impossible\": true}",
            "continueOnBlock": true,
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

---

### 1.10 安全注意事项

1. **验证和清理输入** - 不信任任何输入数据
2. **引用 Shell 变量** - 始终使用 `"$VAR"` 而非 `$VAR`
3. **阻止路径遍历** - 检查 `..` 等遍历模式
4. **使用绝对路径** - 对项目路径使用 `"$CODEBUDDY_PROJECT_DIR"`
5. **跳过敏感文件** - 避免 `.env`、`.git/`、密钥文件等
6. **配置安全** - 启动时捕获 Hooks 快照，外部修改需要到 `/hooks` 面板审查

---

## 二、自定义插件系统

### 2.1 概述

插件是一个**自包含的组件目录**，用于扩展 WorkBuddy 的功能。插件支持以下组件：

| 组件 | 说明 | 目录 |
|------|------|------|
| **Skills（技能）** | AI 自动调用的能力扩展 | `skills/<name>/SKILL.md` |
| **Commands（命令）** | 手动触发的斜杠命令 | `commands/<name>.md` |
| **Agents（代理）** | 专门的子代理 | `agents/<name>.md` |
| **Hooks（钩子）** | 事件处理器 | `hooks/hooks.json` |
| **MCP 服务器** | 外部工具协议集成 | `.mcp.json` |
| **LSP 服务器** | 语言服务器集成 | `.lsp.json` |
| **设置** | 插件默认配置 | `settings.json` |
| **可执行文件** | 添加到 `PATH` 的工具 | `bin/` |
| **输出样式** | 自定义输出格式 | `output-styles/` |

#### 插件 vs 独立配置对比

| 维度 | 独立配置 (`.codebuddy/` 目录) | 插件 |
|------|------------------------------|------|
| 技能名称 | `/hello` | `/plugin-name:hello` |
| 作用域 | 单项目 | 跨项目 / 团队共享 |
| 分发方式 | 手动复制 | 市场安装 |
| 版本管理 | 无 | 语义化版本 |
| 适用场景 | 个人快速实验 | 团队共享、市场分发 |

---

### 2.2 插件目录结构

#### 完整标准布局

```
my-plugin/
├── .codebuddy-plugin/          # 元数据目录（可选，但推荐）
│   └── plugin.json             # 插件清单文件
├── commands/                   # 斜杠命令（可选）
│   ├── status.md
│   └── deploy.md
├── agents/                     # 自定义代理（可选）
│   ├── security-reviewer.md
│   └── performance-tester.md
├── skills/                     # AI 技能（可选）
│   ├── code-reviewer/
│   │   └── SKILL.md
│   └── pdf-processor/
│       ├── SKILL.md
│       └── scripts/
│           └── process-pdf.py
├── output-styles/              # 输出样式（可选）
│   └── terse.md
├── hooks/                      # 钩子配置（可选）
│   ├── hooks.json              # 主钩子配置
│   └── security-hooks.json     # 额外钩子配置
├── bin/                        # 可执行文件（可选，自动加入 PATH）
│   └── my-tool
├── settings.json               # 插件默认设置（可选）
├── .mcp.json                   # MCP 服务器定义（可选）
├── .lsp.json                   # LSP 服务器配置（可选）
├── scripts/                    # 钩子和实用脚本（可选）
│   ├── security-scan.sh
│   ├── format-code.py
│   └── deploy.js
├── LICENSE                     # 许可证文件（可选）
└── CHANGELOG.md                # 版本历史（可选）
```

#### 重要规则

> ⚠️ **常见错误**：不要将 `commands/`、`agents/`、`skills/` 或 `hooks/` 放在 `.codebuddy-plugin/` 目录内。只有 `plugin.json` 放在 `.codebuddy-plugin/` 内，所有其他目录必须在**插件根目录**层级。

#### 文件位置速查表

| 组件 | 默认位置 | 用途 |
|------|----------|------|
| 清单 | `.codebuddy-plugin/plugin.json` | 插件元数据和配置 |
| 命令 | `commands/` | 斜杠命令 Markdown 文件 |
| 代理 | `agents/` | 子代理 Markdown 文件 |
| 技能 | `skills/<name>/SKILL.md` | AI 技能定义 |
| 输出样式 | `output-styles/` | 输出样式定义 |
| 钩子 | `hooks/hooks.json` | 钩子配置 |
| MCP 服务器 | `.mcp.json` | MCP 服务器定义 |
| LSP 服务器 | `.lsp.json` | 语言服务器配置 |
| 可执行文件 | `bin/` | 添加到 PATH |
| 设置 | `settings.json` | 默认配置 |

#### 路径行为规则

- 对于 `commands`、`agents`、`skills` 和 `outputStyles`，自定义路径会**替换**默认目录
- 所有路径必须相对于插件根目录并以 `./` 开头
- 可以通过数组指定多个路径
- 要保留默认目录并添加更多路径，在数组中包含默认目录

**自定义路径示例：**

```json
{
  "commands": [
    "./commands/",
    "./extras/deploy.md"
  ],
  "agents": [
    "./custom-agents/reviewer.md",
    "./custom-agents/tester.md"
  ]
}
```

---

### 2.3 插件清单（plugin.json）

#### 完整 Schema

```json
{
  "name": "my-plugin",
  "version": "1.2.0",
  "description": "插件的简短描述",
  "author": {
    "name": "作者名称",
    "email": "author@example.com",
    "url": "https://github.com/author"
  },
  "homepage": "https://docs.example.com/plugin",
  "repository": "https://github.com/author/plugin",
  "license": "MIT",
  "keywords": ["keyword1", "keyword2"],
  "commands": ["./custom/commands/"],
  "agents": "./custom/agents/",
  "skills": "./custom/skills/",
  "hooks": "./config/hooks.json",
  "mcpServers": "./mcp-config.json",
  "outputStyles": "./styles/",
  "lspServers": "./.lsp.json",
  "userConfig": {
    "api_endpoint": {
      "description": "您团队的 API 端点",
      "sensitive": false
    },
    "api_token": {
      "description": "API 认证令牌",
      "sensitive": true
    }
  },
  "channels": [
    {
      "server": "telegram",
      "userConfig": {
        "bot_token": {
          "description": "Telegram bot token",
          "sensitive": true
        }
      }
    }
  ]
}
```

#### 字段说明

| 字段 | 类型 | 必需 | 描述 | 示例 |
|------|------|:---:|------|------|
| `name` | string | ✅ | 唯一标识符（kebab-case，无空格） | `"deployment-tools"` |
| `version` | string | 推荐 | 语义化版本号 | `"1.0.0"` |
| `description` | string | 推荐 | 插件用途简述 | `"部署自动化工具"` |
| `author` | object | ❌ | 作者信息 | `{"name": "开发团队"}` |
| `homepage` | string | ❌ | 文档 URL | `"https://docs.example.com"` |
| `repository` | string | ❌ | 源代码 URL | `"https://github.com/user/plugin"` |
| `license` | string | ❌ | 许可证标识符 | `"MIT"`, `"Apache-2.0"` |
| `keywords` | array | ❌ | 发现标签 | `["deployment", "ci-cd"]` |
| `commands` | string/array | ❌ | 自定义命令路径 | `["./commands/"]` |
| `agents` | string/array | ❌ | 自定义代理路径 | `"./custom-agents/"` |
| `skills` | string/array | ❌ | 自定义技能路径 | `"./custom-skills/"` |
| `hooks` | string/array/object | ❌ | 钩子配置路径或内联 | `"./hooks/hooks.json"` |
| `mcpServers` | string/array/object | ❌ | MCP 配置路径或内联 | `".mcp.json"` |
| `outputStyles` | string/array | ❌ | 自定义输出样式路径 | `"./styles/"` |
| `lspServers` | string/array/object | ❌ | LSP 配置路径或内联 | `".lsp.json"` |
| `userConfig` | object | ❌ | 启用时提示用户配置 | 见下方 |
| `channels` | array | ❌ | 消息频道声明 | 见下方 |

#### userConfig 详细说明

键规则：键必须是有效标识符。

```json
{
  "userConfig": {
    "api_endpoint": {
      "description": "您团队的 API 端点",
      "sensitive": false
    }
  }
}
```

**替换规则：**
- 可作为 `${user_config.KEY}` 在 MCP/LSP/Hooks 命令中替换
- 非敏感值可在技能和代理内容中替换
- 值也作为 `CODEBUDDY_PLUGIN_OPTION_<KEY>` 环境变量导出

**存储方式：**
- 非敏感值 → `settings.json` 的 `pluginConfigs[<plugin-id>].options` 中
- 敏感值 → 系统密钥链（或 `~/.codebuddy/.credentials.json`，作为备用）

#### channels 详细说明

```json
{
  "channels": [
    {
      "server": "telegram",
      "userConfig": {
        "bot_token": { "description": "Telegram bot token", "sensitive": true },
        "owner_id": { "description": "您的 Telegram 用户 ID", "sensitive": false }
      }
    }
  ]
}
```

`server` 必须匹配插件 `mcpServers` 中的一个键。每个频道绑定到插件提供的一个 MCP 服务器。

---

### 2.4 组件详解

#### 2.4.1 Skills（技能）

技能让 WorkBuddy 的 AI 能根据任务上下文自动调用你的自定义能力。

**创建步骤：**

```
skills/
└── my-skill/
    └── SKILL.md
```

**SKILL.md 格式：**

```markdown
---
name: my-skill
description: 描述这个技能的用途和调用时机
---

# 技能指令

在这里编写详细的指令，告诉 AI 如何使用这个技能。

## 使用参数

用户输入的内容可以通过 $ARGUMENTS 获取：

我的名字是 $ARGUMENTS
```

**Frontmatter 字段：**

| 字段 | 必需 | 说明 |
|------|:---:|------|
| `name` | ✅ | 技能名称，作为技能标识符 |
| `description` | ✅ | 描述何时使用此技能，AI 根据此描述自动决定是否调用 |
| `disable-model-invocation` | ❌ | 设为 `true` 只作为命令使用，不由 AI 自动调用 |
| `hooks` | ❌ | 在技能生命周期内注册的 Hooks（受 `allowUntrustedFrontmatterHooks` 控制） |

**调用方式：**

```bash
/plugin-name:my-skill
/plugin-name:my-skill 参数内容
```

**使用场景示例：**
- 代码审查技能
- PDF 处理技能
- 项目部署技能
- API 生成技能

#### 2.4.2 Commands（命令）

命令是用户通过斜杠手动触发的简单功能。

**创建步骤：**

```
commands/
└── status.md
```

**status.md 格式：**

```markdown
---
description: "显示当前项目状态"
argument-hint: "[参数]"
---

这是一个示例命令。当用户输入 /my-plugin:status 时会执行此命令。

参数：$ARGUMENTS
```

**调用方式：**

```bash
/plugin-name:status
/plugin-name:status --verbose
```

#### 2.4.3 Agents（代理）

代理是专门的子代理，配置了特定模型、工具和行为。

**创建步骤：**

```
agents/
└── security-reviewer.md
```

**security-reviewer.md 格式：**

```markdown
---
name: security-reviewer
description: 安全代码审查代理。用于审查代码中的安全漏洞、注入点、权限问题等。
model: sonnet
effort: high
maxTurns: 20
disallowedTools: Write, Edit
skills: code-review
background: >
  你是一名资深安全工程师...
---

# 系统提示

你是一个专门的安全审查代理，负责检查代码中的安全隐患。
```

**Frontmatter 字段：**

| 字段 | 必需 | 类型 | 说明 |
|------|:---:|------|------|
| `name` | ✅ | string | 代理名称 |
| `description` | ✅ | string | 代理专长和调用时机描述 |
| `model` | ❌ | string | 使用的模型 ID |
| `effort` | ❌ | string | 努力程度：`low` / `medium` / `high` |
| `maxTurns` | ❌ | number | 最大交互轮次 |
| `tools` | ❌ | array | 允许的工具列表 |
| `disallowedTools` | ❌ | array | 禁止的工具列表 |
| `skills` | ❌ | string/array | 关联的技能名称 |
| `memory` | ❌ | boolean | 是否启用记忆 |
| `background` | ❌ | string | 背景信息，作为系统提示的一部分 |
| `isolation` | ❌ | string | 唯一有效值：`"worktree"` |

**安全限制：** 插件代理不支持 `hooks`、`mcpServers` 和 `permissionMode` 字段。

#### 2.4.4 MCP Servers（MCP 服务器）

配置放在 `.mcp.json` 或 `plugin.json` 的 `mcpServers` 字段。

**配置示例：**

```json
{
  "mcpServers": {
    "my-database": {
      "command": "${CODEBUDDY_PLUGIN_ROOT}/servers/db-server",
      "args": ["--config", "${CODEBUDDY_PLUGIN_ROOT}/config.json"],
      "env": {
        "DB_PATH": "${CODEBUDDY_PLUGIN_ROOT}/data"
      }
    },
    "my-api": {
      "command": "npx",
      "args": ["@company/mcp-server", "--plugin-mode"],
      "cwd": "${CODEBUDDY_PLUGIN_ROOT}"
    }
  }
}
```

**集成行为：**
- 插件启用时自动启动 MCP 服务器
- 服务器以标准 MCP 工具形式出现在工具包中
- 插件服务器可独立于用户 MCP 服务器进行配置

#### 2.4.5 LSP Servers（LSP 服务器）

**配置示例（`.lsp.json`）：**

```json
{
  "go": {
    "command": "gopls",
    "args": ["serve"],
    "extensionToLanguage": {
      ".go": "go"
    }
  }
}
```

**必需字段：** `command`、`extensionToLanguage`

**可选字段：**

| 字段 | 说明 |
|------|------|
| `args` | 命令行参数 |
| `transport` | 通信方式：`stdio`（默认）或 `socket` |
| `env` | 环境变量 |
| `initializationOptions` | 初始化选项 |
| `settings` | 通过 `workspace/didChangeConfiguration` 传递的设置 |
| `workspaceFolder` | 工作区路径 |
| `startupTimeout` | 启动超时（毫秒） |
| `shutdownTimeout` | 关闭超时（毫秒） |
| `restartOnCrash` | 崩溃后是否自动重启 |
| `maxRestarts` | 最大重启次数 |

**重要提醒：** 用户必须**单独安装**二进制语言服务器，LSP 插件只配置如何连接。

#### 2.4.6 插件 Hooks

插件中的 Hooks 通过 `hooks/hooks.json` 文件定义：

```json
{
  "description": "代码格式化",
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "${CODEBUDDY_PLUGIN_ROOT}/scripts/format.sh",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

**插件 Hooks 的特点：**
- 插件启用时自动与用户级/项目级 Hooks 合并（**不覆盖**）
- **不受** `allowUntrustedFrontmatterHooks` 安全闸门约束
- 使用 `${CODEBUDDY_PLUGIN_ROOT}` 环境变量引用插件文件路径

#### 2.4.7 默认设置（settings.json）

在插件根目录放置 `settings.json` 文件，启用时应用默认配置。

```json
{
  "agent": "security-reviewer"
}
```

目前仅支持 `agent` 键，用于激活插件的一个自定义代理作为**主线程代理**。

---

### 2.5 环境变量

| 变量 | 解析路径 | 特性 |
|------|----------|------|
| `${CODEBUDDY_PLUGIN_ROOT}` | 插件安装目录的绝对路径 | 更新时变化，写入文件不保留 |
| `${CODEBUDDY_PLUGIN_DATA}` | `~/.codebuddy/plugins/data/{id}/` | 持久化目录，更新后保留 |

**兼容性：** 同时支持 `${CLAUDE_PLUGIN_ROOT}` 和 `${CLAUDE_PLUGIN_DATA}`

**持久化数据目录示例：**

```
插件名称: formatter@my-marketplace
→ 解析为: ~/.codebuddy/plugins/data/formatter-my-marketplace/
```

**推荐用法（SessionStart 钩子自动检测并安装依赖）：**

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "diff -q \"${CODEBUDDY_PLUGIN_ROOT}/package.json\" \"${CODEBUDDY_PLUGIN_DATA}/package.json\" >/dev/null 2>&1 || (cd \"${CODEBUDDY_PLUGIN_DATA}\" && cp \"${CODEBUDDY_PLUGIN_ROOT}/package.json\" . && npm install) || rm -f \"${CODEBUDDY_PLUGIN_DATA}/package.json\""
          }
        ]
      }
    ]
  }
}
```

---

### 2.6 安装作用域

| 作用域 | 设置文件 | 使用场景 |
|--------|----------|----------|
| `user` | `~/.codebuddy/settings.json` | 个人插件，所有项目可用（**默认**） |
| `project` | `.codebuddy/settings.json` | 团队插件，通过版本控制共享 |
| `local` | `.codebuddy/settings.local.json` | 项目特定插件，被 gitignore |
| `managed` | 托管设置 | 托管插件（只读，仅支持更新） |

---

### 2.7 CLI 命令参考

#### 2.7.1 安装插件

```bash
codebuddy plugin install <plugin> [options]

# 选项
-s, --scope <scope>    # 安装作用域：user|project|local（默认：user）
-h, --help             # 显示帮助

# 示例
codebuddy plugin install formatter@my-marketplace
codebuddy plugin install formatter@my-marketplace --scope project
codebuddy plugin install formatter@my-marketplace --scope local
```

#### 2.7.2 卸载插件

```bash
codebuddy plugin uninstall <plugin> [options]

# 别名：remove, rm

# 选项
-s, --scope <scope>    # 从指定作用域卸载
--keep-data            # 保留持久化数据目录
```

#### 2.7.3 启用/禁用插件

```bash
codebuddy plugin enable <plugin> [options]
codebuddy plugin disable <plugin> [options]

# 选项
-s, --scope <scope>    # 作用域
```

#### 2.7.4 更新插件

```bash
codebuddy plugin update <plugin> [options]

# 选项
-s, --scope <scope>    # 更新作用域：user|project|local|managed
```

#### 2.7.5 市场管理

```bash
# 添加市场
codebuddy plugin marketplace add <source> [--name <name>]

# 列出市场
codebuddy plugin marketplace list

# 更新市场
codebuddy plugin marketplace update <name>

# 删除市场
codebuddy plugin marketplace remove <name>
```

**市场源格式：**

| 格式 | 示例 |
|------|------|
| 本地目录 | `codebuddy plugin marketplace add /path/to/marketplace` |
| GitHub 简写 | `codebuddy plugin marketplace add owner/repo` |
| Git URL | `codebuddy plugin marketplace add https://github.com/owner/repo.git` |
| HTTP URL | `codebuddy plugin marketplace add https://example.com/marketplace.json` |

#### 2.7.6 本地测试插件

```bash
codebuddy --plugin-dir ./my-plugin
codebuddy --plugin-dir ./plugin-one --plugin-dir ./plugin-two  # 多个插件
```

修改后使用 `/reload-plugins` 热重载。

---

### 2.8 缓存与文件解析

- **市场插件**会被复制到本地缓存：`~/.codebuddy/plugins/cache/`
- 已安装插件不能引用其目录之外的文件（路径遍历被限制）
- 指向外部文件的符号链接在复制过程中会被保留

**创建外部依赖的符号链接：**

```bash
# 在插件目录内操作
ln -s /path/to/shared-utils ./shared-utils
```

---

## 三、独立配置（非插件方式）

对于**个人单项目**使用场景，可以直接在项目 `.codebuddy/` 目录中配置 Hooks，无需创建插件。

**配置位置：**

```
项目根目录/
├── .codebuddy/
│   ├── settings.json        # Hooks配置放在这里
│   ├── settings.local.json  # 本地私有配置
│   ├── hooks/               # 存放Hook脚本
│   │   ├── pre-check.sh
│   │   └── format.sh
│   ├── skills/              # 自定义技能
│   │   └── hello/SKILL.md
│   └── commands/            # 自定义命令
│       └── status.md
```

**配置示例：**

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"$CODEBUDDY_PROJECT_DIR\"/.codebuddy/hooks/pre-check.sh",
            "timeout": 10
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "\"$CODEBUDDY_PROJECT_DIR\"/.codebuddy/hooks/format.sh",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

---

## 四、调试与故障排除

### 4.1 调试命令

```bash
codebuddy --debug
```

### 4.2 查看钩子状态

在对话中输入 `/hooks` 查看当前注册的所有 Hooks。

### 4.3 常见问题排查表

| 问题 | 可能原因 | 解决方案 |
|------|---------|---------|
| 插件未加载 | `plugin.json` 无效 | 运行 `codebuddy plugin validate` |
| 命令未出现 | 目录结构错误 | 确保目录在插件根目录，不在 `.codebuddy-plugin/` 内 |
| 钩子未触发 | 脚本不可执行 | 运行 `chmod +x script.sh` |
| MCP 服务器失败 | 路径缺少 `$CODEBUDDY_PLUGIN_ROOT` | 所有插件路径使用此变量 |
| 路径错误 | 使用了绝对路径 | 所有路径必须是相对路径，以 `./` 开头 |
| LSP 未找到 | 语言服务器未安装 | 用户必须预装二进制文件 |
| 引号问题 | JSON 引号未转义 | 使用 `\"` 转义引号 |
| 匹配器不工作 | 大小写不匹配 | `PreToolUse` 非 `pretooluse` |
| 命令找不到 | 未使用完整路径 | 脚本使用完整路径 |

### 4.4 钩子排查清单

1. 确认脚本可执行：`chmod +x ./scripts/your-script.sh`
2. 验证 shebang 行正确
3. 确认路径使用 `${CODEBUDDY_PLUGIN_ROOT}`
4. 手动测试脚本能否正常运行
5. 验证事件名正确（区分大小写）
6. 检查 matcher 模式是否匹配
7. 确认钩子类型 `type` 字段有效

---

## 五、与 Claude Code 兼容性

### 5.1 命名差异

| 概念 | Claude Code | WorkBuddy |
|------|------------|-----------|
| 元数据目录 | `.claude-plugin/` | `.codebuddy-plugin/`（优先，但也兼容前两者） |
| 插件根变量 | `${CLAUDE_PLUGIN_ROOT}` | `${CODEBUDDY_PLUGIN_ROOT}`（优先，也兼容） |
| 数据目录变量 | `${CLAUDE_PLUGIN_DATA}` | `${CODEBUDDY_PLUGIN_DATA}`（优先，也兼容） |

### 5.2 迁移指南

从 Claude Code 迁移到 WorkBuddy：
1. 可选择将 `.claude-plugin/` → `.codebuddy-plugin/`
2. 可选择替换脚本中的环境变量名
3. **保持原名也完全兼容**，WorkBuddy 自动识别

---

## 附录

### A. 快速创建第一个插件

```bash
# 1. 创建目录
mkdir -p my-first-plugin/.codebuddy-plugin
mkdir -p my-first-plugin/skills/hello

# 2. 创建清单
cat > my-first-plugin/.codebuddy-plugin/plugin.json << 'EOF'
{
  "name": "my-first-plugin",
  "description": "一个示例问候插件",
  "version": "1.0.0",
  "author": { "name": "开发者" }
}
EOF

# 3. 创建技能
cat > my-first-plugin/skills/hello/SKILL.md << 'EOF'
---
name: hello
description: 向用户发送友好的问候
disable-model-invocation: true
---

# 问候技能

热情地问候用户并询问今天如何帮助他们。

用户名称：$ARGUMENTS
EOF

# 4. 测试插件
codebuddy --plugin-dir ./my-first-plugin
# 然后输入 /my-first-plugin:hello
```

### B. 参考资料

- [Hooks 官方文档](https://www.codebuddy.cn/docs/cli/hooks)
- [创建插件](https://www.codebuddy.cn/docs/cli/plugins)
- [插件参考文档](https://www.codebuddy.cn/docs/cli/plugins-reference)
- [插件市场](https://www.codebuddy.cn/docs/cli/plugin-marketplaces)

---

> 文档版本: 1.0 | 最后更新: 2026-07-04