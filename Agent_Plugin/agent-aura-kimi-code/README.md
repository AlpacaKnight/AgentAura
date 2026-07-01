# AgentAura Kimi Code Plugin

将 Kimi Code CLI 的 hooks 生命周期状态同步到 AgentAura 设备，兼容：

- `ESP32-RingLight` 固件
- `PetDesktop`

插件通过 Kimi Code 官方 hooks 机制触发本地 CLI，把事件映射为固件文档中的 `agent <状态>` 指令；HTTP 模式下也会附带 `x-agentaura-*` 标识头，便于 PetDesktop 区分来自 Kimi 的实例。

## 状态映射

| Kimi hook | AgentAura 状态 | 说明 |
| :--- | :--- | :--- |
| `SessionStart` | `init` | 会话启动或恢复 |
| `UserPromptSubmit` | `running` | 用户提交消息 |
| `PreToolUse` | `busy` | 即将调用工具 |
| `PermissionRequest` | `waiting` | 等待审批 |
| `PermissionResult` | `running` / `error` | 审批通过恢复运行，拒绝则报错 |
| `PostToolUse` | `running` | 工具成功结束 |
| `PostToolUseFailure` | `error` | 工具失败 |
| `SubagentStart` | `busy` | 子 Agent 开始 |
| `SubagentStop` | `running` | 子 Agent 完成 |
| `PreCompact` | `busy` | 压缩上下文前 |
| `PostCompact` | `running` | 压缩完成 |
| `Stop` | `idle` | 本轮正常结束 |
| `StopFailure` | `error` | 本轮异常结束 |
| `Interrupt` | `idle` | 用户中断当前轮次 |
| `SessionEnd` | `offline` | 会话退出 |

这些状态与固件 [API 文档](../../Arduino_ESP32_RingLight/ESP32_RingLight_Firmware/doc/API.md) 和 [PetDesktop API](../../PetDesktop/API.md) 里的状态枚举一致。

## 功能

- 支持 HTTP、UDP、USB 串口三种传输方式。
- 支持 UDP 广播发现设备；发现到 `PetDesktop` 时会自动使用它广播返回的 HTTP 端口 `47831`。
- 安装/卸载时会在 `~/.kimi-code/config.toml` 中维护一段独立的 AgentAura hooks 块，不会破坏其它 hooks。
- 默认开启同步；关闭后 hook 会立即 no-op。
- Hook 异常全部吞掉，不影响 Kimi Code 主流程。
- HTTP 请求会附带 `x-agentaura-client: kimi` 等头，PetDesktop 可以把它识别成独立 agent 实例。

## 安装与配置

```bash
cd Agent_Plugin/agent-aura-kimi-code
npm install
npm run compile

node out/index.js config init
node out/index.js configure --discover
node out/index.js configure --transport http --host 127.0.0.1 --port 47831
node out/index.js install-hooks
node out/index.js uninstall-hooks
node out/index.js test busy
```

如果目标是 ESP32 固件 HTTP：

```bash
node out/index.js configure --transport http --host 192.168.1.100 --port 80
```

全局安装后也可以直接执行：

```bash
agent-aura-kimi-code config init
agent-aura-kimi-code configure --discover
agent-aura-kimi-code install-hooks
agent-aura-kimi-code uninstall-hooks
agent-aura-kimi-code test busy
```

## 连接方式

### HTTP

推荐连接 `PetDesktop` 或已联网的 `ESP32-RingLight`：

```bash
agent-aura-kimi-code configure --transport http --host 127.0.0.1 --port 47831
agent-aura-kimi-code configure --transport http --host 192.168.1.100 --port 80
```

- ESP32 固件：优先调用 `POST /api/agent?state=<state>`，原始命令走 `POST /api/cmd`
- PetDesktop：兼容同一接口，并读取 `x-agentaura-*` 头作为 agent 身份

如果 PetDesktop 开启了 LAN Token，可附带：

```bash
agent-aura-kimi-code configure --auth-token your-token
```

### UDP

```bash
agent-aura-kimi-code configure --transport udp --host 192.168.1.100 --port 8888
```

UDP 会发送 `agent busy\n` 这样的文本指令。PetDesktop 也兼容 UDP，但不会保留 HTTP 那种实例身份头。

### USB 串口

```bash
agent-aura-kimi-code configure --transport serial --serial-port /dev/ttyACM0 --baud 115200
```

## 常用命令

```bash
agent-aura-kimi-code status
agent-aura-kimi-code status --probe
agent-aura-kimi-code discover
agent-aura-kimi-code discover --save
agent-aura-kimi-code command "rgb 255,0,0"
agent-aura-kimi-code command "effect rainbow"
agent-aura-kimi-code disable
agent-aura-kimi-code enable
agent-aura-kimi-code uninstall-hooks
```

配置文件默认写入 `~/.kimi-code/agent-aura-kimi-code.json`，hooks 配置文件默认是 `~/.kimi-code/config.toml`。

## Hooks 安装方式

执行 `install-hooks` 后，插件会在 `~/.kimi-code/config.toml` 写入一段带 `BEGIN/END AGENTAURA_KIMI_CODE_HOOKS` 标记的 `[[hooks]]` 配置块。Kimi Code 官方 hooks 文档要求 hook 定义位于 `[[hooks]]` 数组中，并通过 `stdin` 传入 JSON 事件数据。

安装、查看、移除 hooks 的常用命令放在一起如下：

```bash
agent-aura-kimi-code install-hooks
agent-aura-kimi-code hooks print
agent-aura-kimi-code uninstall-hooks
agent-aura-kimi-code hooks uninstall
```

说明：
- `install-hooks`：写入或刷新本插件管理的 hooks 配置块。
- `hooks print`：只打印将写入的 hooks 内容，不修改文件。
- `uninstall-hooks` / `hooks uninstall`：只删除本插件写入的标记块，不影响其它 Kimi 配置或其它 hooks。

## 配置文件

查看路径：

```bash
agent-aura-kimi-code config path
```

示例内容见 [agent-aura-kimi-code.config.example.json](agent-aura-kimi-code.config.example.json)。

环境变量也可临时覆盖：

```bash
AGENTAURA_KIMI_CODE_CONFIG=/path/to/agent-aura-kimi-code.json
AGENTAURA_KIMI_CODE_TRANSPORT=http
AGENTAURA_KIMI_CODE_HOST=127.0.0.1
AGENTAURA_KIMI_CODE_PORT=47831
AGENTAURA_KIMI_CODE_AUTH_TOKEN=
```

也兼容通用变量 `AGENTAURA_HOST`、`AGENTAURA_TRANSPORT`、`AGENTAURA_AUTH_TOKEN`。
