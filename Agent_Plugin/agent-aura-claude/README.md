# AgentAura Claude Plugin

将 Claude Code 的生命周期状态同步到 AgentAura ESP32 环形灯。插件通过 Claude Code hooks 调用固件文档里的 `agent <状态>` 指令，不需要修改固件。

## 状态映射

| Claude Code hook | AgentAura 状态 | 环形灯表现 |
| :--- | :--- | :--- |
| `SessionStart` | `init` | 彩虹初始化，随后自动关灯 |
| `UserPromptSubmit` | `running` | 绿色呼吸，收到用户请求 |
| `PreToolUse` / `SubagentStart` / `TaskCreated` | `busy` | 黄色跑马，正在调用工具或子智能体 |
| `PermissionRequest` / permission notification | `waiting` | 黄色闪烁，等待审批 |
| `PostToolUse` / `PostToolBatch` | `running` | 工具结束后继续运行 |
| `PostToolUseFailure` / `PermissionDenied` / `StopFailure` | `error` | 红色闪烁 |
| `Stop` / idle notification | `idle` | 蓝色呼吸，5 秒后自动关灯 |
| `SessionEnd` | `offline` | 关灯 |

这些状态对应固件 API 文档中的 `agent running/busy/waiting/error/idle/init/offline/upgrade`。

## 功能

- Claude Code 原生插件结构：`.claude-plugin/plugin.json` + `hooks/hooks.json` + `commands/`。
- 提供 `/agent-aura-claude:aura` slash 命令（`on/off` 开关、点灯、发指令、查看状态），在会话内直接控制环形灯。
- 支持 HTTP、UDP、USB 串口三种传输方式。
- 支持 UDP 广播发现设备，发现后自动保存 HTTP 连接配置。
- 支持 Claude 插件 `userConfig`，也支持命令行配置文件和环境变量覆盖。
- Hook 命令吞掉异常，设备离线不会打断 Claude Code。
- 内置状态去抖、失败冷却和发现失败冷却，避免频繁重启灯效或拖慢 hook。

## 安装

通过 marketplace 安装。仓库在 [Agent_Plugin/.claude-plugin/marketplace.json](../.claude-plugin/marketplace.json) 提供 marketplace 清单，在 Claude Code 中执行：

```text
/plugin marketplace add /home/xuyd2/Git/open/AgentAura/Agent_Plugin
/plugin install agent-aura-claude@agentaura
```

推送到 GitHub 后，可用 `/plugin marketplace add <user>/<repo>` 安装。安装后运行 `/reload-plugins` 或重启会话使 hooks 生效。

> `serialport` 是原生模块，随插件依赖一起安装，需本机具备 Node 编译工具链。

## 配置

安装后在 Claude Code 的 `/plugin` 界面通过 `userConfig` 配置设备：

| 字段 | 说明 | 默认 |
| :--- | :--- | :--- |
| `enabled` | 是否同步状态到环形灯 | `true` |
| `transport` | 传输方式：`http` / `udp` / `serial` | `http` |
| `host` | HTTP/UDP 设备 IP，留空则用 UDP 发现 | 空 |
| `port` | HTTP 默认 `80`，UDP 默认 `8888` | `80` |
| `serial_port` | USB CDC 串口路径，如 `/dev/ttyACM0` | 空 |
| `baud` | 串口波特率 | `115200` |
| `auto_discover` | `host` 为空时在 UDP 8888 自动发现设备 | `true` |

常见组合：

- HTTP：`transport=http`、`host=192.168.1.100`、`port=80`
- UDP：`transport=udp`、`host=192.168.1.100`、`port=8888`
- USB 串口：`transport=serial`、`serial_port=/dev/ttyACM0`、`baud=115200`
- 自动发现：`host` 留空且 `auto_discover=true`

改完配置后运行 `/reload-plugins` 或重启会话。

## 工作方式

插件通过 hooks 自动把 Claude Code 生命周期状态同步到环形灯（见上方状态映射）。设备离线时 hook 静默跳过，不影响 Claude Code。

- HTTP：发送状态调用固件 `POST /api/agent?state=<state>`，发送原始指令调用 `POST /api/cmd`。
- UDP：直接发送文本指令，例如 `agent busy\n`。
- USB 串口：通过 CDC 串口发送同样的文本指令。

## 控制命令（Claude Code 内）

插件提供一个 `/agent-aura-claude:aura` slash 命令（插件命令带插件名命名空间前缀），安装后在 Claude Code 会话里直接调用，复用 `/plugin` 里配好的设备连接：

| 命令 | 作用 |
| :--- | :--- |
| `/agent-aura-claude:aura on` | 启用状态同步 |
| `/agent-aura-claude:aura off` | 暂停状态同步（hooks 静默） |
| `/agent-aura-claude:aura <state>` | 点亮一次指定状态灯效 |
| `/agent-aura-claude:aura cmd <指令>` | 发送原始固件指令 |
| `/agent-aura-claude:aura status` 或 `/agent-aura-claude:aura` | 查看配置并探测设备 |

示例：`/agent-aura-claude:aura busy`、`/agent-aura-claude:aura cmd rgb 255,0,0`。`<state>` 可取 `busy` / `waiting` / `idle` / `running` / `error` / `init` / `offline`。

`on` 与 `off` 控制插件是否向环形灯同步状态：`off` 写入禁用标记，hooks 会静默跳过，`on` 清除该标记。若命令未出现，运行 `/reload-plugins` 或重启会话。

## 本地开发与排障

从克隆的源码目录可用 `--plugin-dir` 临时加载插件，并用内置 CLI 手动测试：

```bash
cd /home/xuyd2/Git/open/AgentAura/Agent_Plugin/agent-aura-claude
npm install
npm run build
claude --plugin-dir .
```

内置 CLI 仅用于源码目录下的排障与手动测试：

```bash
node bin/agent-aura-claude.js configure --discover     # 发现并保存设备
node bin/agent-aura-claude.js test busy                # 测试灯效
node bin/agent-aura-claude.js discover                 # 扫描设备
node bin/agent-aura-claude.js status --probe           # 查看配置并探测 /api/state
node bin/agent-aura-claude.js command "rgb 255,0,0"    # 发送固件指令
node bin/agent-aura-claude.js config init              # 生成默认配置文件
```

CLI 配置文件位于 `~/.claude/agent-aura-claude.json`，示例见 [agent-aura-claude.config.example.json](agent-aura-claude.config.example.json)。环境变量可临时覆盖，例如 `AGENTAURA_CLAUDE_HOST`、`AGENTAURA_CLAUDE_TRANSPORT`，也兼容通用变量 `AGENTAURA_HOST`、`AGENTAURA_TRANSPORT`。
