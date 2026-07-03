# AgentAura Qwen Code Plugin

将 Qwen Code 的 hooks 生命周期状态同步到 AgentAura 设备，兼容：

- `ESP32-RingLight` 固件
- `PetDesktop`

插件通过 Qwen Code 官方 hooks 机制触发本地 CLI，把事件映射为固件文档中的 `agent <状态>` 指令；HTTP 模式下也会附带 `x-agentaura-*` 标识头，便于 PetDesktop 区分来自 Qwen Code 的实例。

## 状态映射

| Qwen hook | AgentAura 状态 | 说明 |
| :--- | :--- | :--- |
| `SessionStart` | `init` | 会话启动或恢复 |
| `UserPromptSubmit` | `running` | 用户提交消息 |
| `PreToolUse` | `busy` | 即将调用工具 |
| `PermissionRequest` | `waiting` | 等待审批 |
| `PostToolUse` | `running` | 工具成功结束 |
| `PostToolUseFailure` | `error` | 工具失败 |
| `SubagentStart` | `busy` | 子 Agent 开始 |
| `SubagentStop` | `running` | 子 Agent 完成 |
| `PreCompact` | `busy` | 压缩上下文前 |
| `Notification(permission_prompt)` | `waiting` | 权限或交互提示 |
| `Stop` | `idle` | 本轮正常结束 |
| `SessionEnd` | `offline` | 会话退出 |

这些状态与固件 [API 文档](../../Arduino_ESP32_RingLight/ESP32_RingLight_Firmware/doc/API.md) 和 [PetDesktop API](../../PetDesktop/API.md) 里的状态枚举一致。

## 功能

- 支持 HTTP、UDP、USB 串口三种传输方式。
- 支持 UDP 广播发现设备；发现到 `PetDesktop` 时会自动使用它广播返回的 HTTP 端口 `47831`。
- 安装/卸载时会在 `~/.qwen/settings.json` 的 `hooks` 字段中维护独立的 AgentAura hook 项，不会破坏其它 hooks。
- 默认开启同步；关闭后 hook 会立即 no-op。
- Hook 异常全部吞掉，不影响 Qwen Code 主流程。
- HTTP 请求会附带 `x-agentaura-client: qwen-code` 等头，PetDesktop 可以把它识别成独立 agent 实例。
- 附带一个最小的 Qwen Code 官方扩展清单 `qwen-extension.json` 和 `QWEN.md`，可直接安装到 `~/.qwen/extensions`。

## 安装与配置

推荐安装方式是：

1. 用打包产物全局安装 CLI
2. 用 Qwen Code 正常安装扩展
3. 用已安装的 `agent-aura-qwencode` 命令写入 hooks
4. 完全退出并重新启动 Qwen Code，让新 hooks 生效

```bash
cd Agent_Plugin/agent-aura-qwencode
npm install
npm run compile
bash scripts/pack.sh

npm install -g dist/agent-aura-qwencode-0.1.0.tgz
qwen extensions install dist/agent-aura-qwencode-0.1.0.zip

agent-aura-qwencode config init
agent-aura-qwencode configure --transport http --host 127.0.0.1 --port 47831 --auto-discover false
agent-aura-qwencode install-hooks
agent-aura-qwencode test busy
```

如果目标是 ESP32 固件 HTTP：

```bash
agent-aura-qwencode configure --transport http --host 192.168.1.100 --port 80
```

开发调试时也可以直接在源码目录运行：

```bash
node out/index.js status
node out/index.js test busy
```

但正常使用时，不要在源码目录执行 `node out/index.js install-hooks`，否则 hooks 会写死到源码路径。普通安装和扩展内命令都应使用全局 `agent-aura-qwencode` CLI。

## Qwen Code 扩展安装

Qwen Code 官方扩展和 hooks 是两套机制。这个目录同时包含：

- `qwen-extension.json` / `QWEN.md`：给 `qwen extensions install` 使用
- `commands/`：提供 `/setup`、`/status`、`/hooks:install`、`/hooks:uninstall`
- `agent-aura-qwencode` CLI：负责写入 hooks 配置并向设备发状态

安装扩展：

```bash
qwen extensions install dist/agent-aura-qwencode-0.1.0.zip
```

说明：

- 扩展安装后只会提供扩展上下文，不会自动写入 hooks。
- 应使用全局安装后的 `agent-aura-qwencode install-hooks` 写入 hooks，让 hooks 指向已安装包位置，而不是源码目录。
- Qwen Code 正常安装扩展后会复制一份到 `~/.qwen/extensions`。如果你升级扩展内容，需要重新执行 `qwen extensions update agent-aura-qwencode` 或重新安装 zip。
- 只有在开发调试时，才建议使用 `qwen extensions link`。

## 连接方式

### HTTP

推荐连接 `PetDesktop` 或已联网的 `ESP32-RingLight`：

```bash
agent-aura-qwencode configure --transport http --host 127.0.0.1 --port 47831
agent-aura-qwencode configure --transport http --host 192.168.1.100 --port 80
```

- ESP32 固件：优先调用 `POST /api/agent?state=<state>`，原始命令走 `POST /api/cmd`
- PetDesktop：兼容同一接口，并读取 `x-agentaura-*` 头作为 agent 身份

如果 PetDesktop 开启了 LAN Token，可附带：

```bash
agent-aura-qwencode configure --auth-token your-token
```

### UDP

```bash
agent-aura-qwencode configure --transport udp --host 192.168.1.100 --port 8888
```

UDP 会发送 `agent busy\n` 这样的文本指令。PetDesktop 也兼容 UDP，但不会保留 HTTP 那种实例身份头。

### USB 串口

```bash
agent-aura-qwencode configure --transport serial --serial-port /dev/ttyACM0 --baud 115200
```

## 常用命令

```bash
agent-aura-qwencode status
agent-aura-qwencode status --probe
agent-aura-qwencode discover
agent-aura-qwencode discover --save
agent-aura-qwencode command "rgb 255,0,0"
agent-aura-qwencode command "effect rainbow"
agent-aura-qwencode disable
agent-aura-qwencode enable
agent-aura-qwencode uninstall-hooks
```

配置文件默认写入 `~/.qwen/agent-aura-qwencode.json`，hooks 配置文件默认是 `~/.qwen/settings.json`。

## Hooks 安装方式

执行 `install-hooks` 后，插件会在 `~/.qwen/settings.json` 的 `hooks` 字段中写入一组带 `agent-aura-qwencode:` 名称前缀的 hook 项。Qwen Code 官方 hooks 文档使用 JSON 配置，并通过 `stdin` 传入事件数据。

安装、查看、移除 hooks 的常用命令放在一起如下：

```bash
agent-aura-qwencode install-hooks
agent-aura-qwencode hooks print
agent-aura-qwencode uninstall-hooks
agent-aura-qwencode hooks uninstall
```

说明：
- `install-hooks`：写入或刷新本插件管理的 hooks 配置。
- `hooks print`：只打印将写入的 hooks JSON 片段，不修改文件。
- `uninstall-hooks` / `hooks uninstall`：只删除本插件写入的命名 hook 项，不影响其它 Qwen 配置或其它 hooks。

写入的每个 hook 项包含：
- `timeout`：单位是**毫秒**，本插件写入 `15000`（15 秒），足够 Node 启动并完成一次 HTTP 同步。
- `env`：注入 `AGENTAURA_QWENCODE_HOOK=1`，不再在命令行里用 `set`/前缀赋值。
- `shell`：Windows 上为 `powershell`，其它平台为 `bash`，由 Qwen Code 显式选择解释器。
- `command`：使用绝对 Node 路径与入口路径，并对空格、单引号做转义。Windows 使用 PowerShell 调用运算符，例如：

```powershell
& 'C:\Program Files\nodejs\node.exe' 'C:\Users\me\.qwen\extensions\agent-aura-qwencode\out\index.js' hook 'SessionStart'
```

POSIX 使用 bash：

```bash
'/usr/local/bin/node' '/home/me/.qwen/extensions/agent-aura-qwencode/out/index.js' hook 'SessionStart'
```

命令不再吞掉错误输出（不再有 `>nul`、`/dev/null`、`|| true`），hook 的 stderr 会写入 Qwen Code 的 debug 日志，便于排障；插件内部仍会捕获自身异常，不会阻断 Qwen 主流程。

> 修改任何路径环境变量（如 `QWEN_CODE_HOME`）后，需要完全退出并重启 Qwen Code 与 PetDesktop，才能读到新的环境。

## 配置文件

查看路径：

```bash
agent-aura-qwencode config path
```

示例内容见 [agent-aura-qwencode.config.example.json](agent-aura-qwencode.config.example.json)。

环境变量也可临时覆盖：

```bash
AGENTAURA_QWENCODE_CONFIG=/path/to/agent-aura-qwencode.json
AGENTAURA_QWENCODE_TRANSPORT=http
AGENTAURA_QWENCODE_HOST=127.0.0.1
AGENTAURA_QWENCODE_PORT=47831
AGENTAURA_QWENCODE_AUTH_TOKEN=
```

也兼容通用变量 `AGENTAURA_HOST`、`AGENTAURA_TRANSPORT`、`AGENTAURA_AUTH_TOKEN`。

### 路径变量优先级

CLI 与 PetDesktop 使用同一套路径解析规则（空环境变量视为未设置）：

| 用途 | 优先级 |
| :--- | :--- |
| Qwen 目录 | `QWEN_CODE_HOME` > `QWEN_HOME` > `USERPROFILE`/`HOME` 下的 `.qwen` |
| settings（hooks） | `QWEN_CODE_SETTINGS` > `QWEN_SETTINGS_PATH` > `<Qwen 目录>/settings.json` |
| 插件配置 | `AGENTAURA_QWENCODE_CONFIG` > `<Qwen 目录>/agent-aura-qwencode.json` |

这样即使自定义了 Qwen 目录或 settings 路径，App、CLI 与 hooks 也会读写同一份文件。修改这些变量后需重启 Qwen Code 与 PetDesktop。

## ZIP 双安装

通过 PetDesktop 安装 Qwen Code 的 `.zip` 包时会执行两步：

1. **扩展**：卸载同名旧扩展后运行 `qwen extensions install --consent <zip>`，日志前缀 `[qwen extension]`。
2. **托管 CLI**：把同一个 ZIP 安全解压并安装到 PetDesktop 托管目录，日志前缀 `[managed cli]`，供 hooks 使用其绝对 `out/index.js`。

只有两步都成功才返回“安装完成”。若托管 CLI 安装失败，会先尝试恢复失败前的旧版扩展；如果没有可恢复的旧版，再回滚本次扩展安装，并在 `[rollback]` 段落输出结果。ZIP 根目录必须包含 `qwen-extension.json`、`package.json`、`out/index.js`，否则拒绝安装。

hooks 优先执行托管包的绝对 `out/index.js`，安装来源状态优先级为 `managed > global > external`。

## Windows 诊断

如果 Windows 上 hooks 已安装但 PetDesktop 状态不同步，可按顺序排查：

1. 在 Qwen Code 的 `/hooks` 视图里确认存在 `agent-aura-qwencode:*` 项，或者直接查看 settings.json，确认 `shell` 为 `powershell`、`timeout` 为 `15000`。
2. 打开 settings.json，确认 `command` 中的 Node 与入口路径存在且正确。
3. `agent-aura-qwencode status --probe` 检查设备连通性与配置。
4. 查看 Qwen Code 的 debug 日志，hook 的 `[agentaura]` stderr 会显示事件与同步结果。
5. 若从资源管理器启动 PetDesktop 时 GUI PATH 不完整，插件会额外在 `%ProgramFiles%\nodejs`、`%APPDATA%\npm`、NVM/Volta 目录查找 `node`/`npm`/`qwen`，并把解析到的目录前置到子进程 PATH。找不到时错误信息会列出检查过的目录。
6. 修改任何路径环境变量后，完全退出并重启 Qwen Code 与 PetDesktop。
