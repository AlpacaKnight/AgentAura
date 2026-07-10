# AgentAura ZCode Plugin

将 ZCode 的 hooks 生命周期状态同步到 AgentAura 设备，兼容：

- `ESP32-RingLight` 固件
- `PetDesktop`

插件通过 ZCode 原生插件机制（`.zcode-plugin/plugin.json` + `hooks/hooks.json`）注册 hooks，把事件映射为固件文档中的 `agent <状态>` 指令；HTTP 模式下也会附带 `x-agentaura-*` 标识头，便于 PetDesktop 区分来自 ZCode 的实例。

## 状态映射

| ZCode hook | AgentAura 状态 | 说明 |
| :--- | :--- | :--- |
| `SessionStart` | `init` | 会话启动或恢复 |
| `UserPromptSubmit` | `running` | 用户提交消息 |
| `PreToolUse` | `busy` | 即将调用工具 |
| `PermissionRequest` | `waiting` | 等待审批 |
| `PostToolUse` | `running` | 工具成功结束 |
| `PostToolUseFailure` | `error` | 工具失败 |
| `Stop` | `idle` | 本轮正常结束 |

> ZCode 仅支持上述 7 个 hook 事件。`Notification`、`SubagentStart`/`SubagentStop`、`PreCompact`、`SessionEnd` 等事件不被 ZCode 支持，因此本插件不会注册它们。

这些状态与固件 [API 文档](../../Arduino_ESP32_RingLight/ESP32_RingLight_Firmware/doc/API.md) 和 [PetDesktop API](../../PetDesktop/API.md) 里的状态枚举一致。

## 功能

- 原生 ZCode 插件结构：`.zcode-plugin/plugin.json` + `hooks/hooks.json` + `commands/`。
- 插件自带 hooks 自动启用 hook runner，无需手动写配置文件。
- 支持 HTTP、UDP、USB 串口三种传输方式。
- 支持 UDP 广播发现设备；发现到 `PetDesktop` 时会自动使用它广播返回的 HTTP 端口 `47831`。
- 优先连接 PetDesktop 桥接服务（注册、心跳、桌宠气泡消息），回退直连 ESP32 固件。
- 默认开启同步；关闭后 hook 会立即 no-op。
- Hook 异常全部吞掉，不影响 ZCode 主流程。
- HTTP 请求会附带 `x-agentaura-client: zcode` 等头，PetDesktop 可以把它识别成独立 agent 实例。
- 提供 `/agent-aura-zcode:aura`、`/agent-aura-zcode:setup`、`/agent-aura-zcode:status` slash 命令。

## 直连环形灯硬件

本插件完全支持直接连接 ESP32 环形灯硬件（无需 PetDesktop）：

- **HTTP 直连固件**（`--host 192.168.1.100 --port 80`）：首次发送时先尝试 PetDesktop 注册（固件对未注册路由返回 404），失败后回退 `POST /api/agent?state=<state>` 直连固件并缓存目标类型；后续直接走固件，无额外开销。
- **UDP 直连**：直接发送 `agent <state>\n` 文本指令。
- **USB 串口直连**：CDC 串口发送同样的文本指令。
- 直连固件时不支持桌宠气泡消息（固件无文字显示能力），这是预期行为。

## 安装与配置

> **重要**：ZCode 不支持直接安装 zip/tgz 压缩包作为插件（它不是 VS Code 的 VSIX 模型）。
> ZCode 的插件源类型只有 `directory`、`github`、`git`、`url`、`git-subdir`，不支持 `npm`/`pip`。
>
> 通用的安装方式是：**npm 全局安装 CLI（含完整插件文件）→ 用 `plugin-path` 命令获取路径 → 在 ZCode 里添加该路径作为本地 marketplace**。
> 这不依赖本地源码目录，在任何系统/设备上都能使用。

### 方式 A：npm 全局安装（通用，推荐分发方式）

```bash
# 1. 全局安装 CLI（包含完整的插件文件：.zcode-plugin/、hooks/、commands/、bin/、out/）
npm install -g agent-aura-zcode-0.3.0.tgz

# 2. 获取插件路径（输出 npm 全局包目录）
agent-aura-zcode plugin-path
```

`plugin-path` 会输出类似这样的路径：

```
/home/<user>/.nvm/versions/node/v24.14.0/lib/node_modules/agent-aura-zcode
```

然后在 ZCode 客户端操作：

1. 打开 **Settings → Plugin Management → Discover（发现）标签页**
2. 点 **`+`** 按钮，来源选择 **local directory（本地目录）**，填入 `plugin-path` 输出的路径
3. ZCode 会扫描该目录下的 `.zcode-plugin/marketplace.json`，发现 `agent-aura-zcode` 插件
4. 在 Discover 列表里找到 `agent-aura-zcode`，点 **Get** 安装
5. 安装后在 **Installed** 标签页确认已 enabled
6. 运行 `/reload-plugins` 或重启会话让插件生效

### 方式 B：从源码构建安装（开发/本地使用）

```bash
cd Agent_Plugin/agent-aura-zcode
npm install
npm run build          # 生成 out/ 编译产物（插件 hooks 会调用它）
bash scripts/pack.sh   # 打包 tgz + zip
```

打包后回到方式 A 用 tgz 安装，或直接用源码目录作为 marketplace：

1. ZCode → **Settings → Plugin Management → Discover → `+`**
2. 添加本地目录：`<仓库路径>/Agent_Plugin/agent-aura-zcode`
3. 安装 `agent-aura-zcode` 插件

### 本地开发加载

```bash
zcode --plugin-dir Agent_Plugin/agent-aura-zcode
```

### 配置设备

如果目标是本机 PetDesktop：

```bash
agent-aura-zcode config init
agent-aura-zcode configure --transport http --host 127.0.0.1 --port 47831 --auto-discover false
agent-aura-zcode test busy
```

如果目标是局域网 ESP32 固件：

```bash
agent-aura-zcode configure --transport http --host 192.168.1.100 --port 80
```

开发调试时也可以直接在源码目录运行：

```bash
node out/index.js status
node out/index.js test busy
```

## 连接方式

### HTTP

推荐连接 `PetDesktop` 或已联网的 `ESP32-RingLight`：

```bash
agent-aura-zcode configure --transport http --host 127.0.0.1 --port 47831
agent-aura-zcode configure --transport http --host 192.168.1.100 --port 80
```

- ESP32 固件：优先调用 `POST /api/agent?state=<state>`，原始命令走 `POST /api/cmd`
- PetDesktop：兼容同一接口，并读取 `x-agentaura-*` 头作为 agent 身份

如果 PetDesktop 开启了 LAN Token，可附带：

```bash
agent-aura-zcode configure --auth-token your-token
```

### UDP

```bash
agent-aura-zcode configure --transport udp --host 192.168.1.100 --port 8888
```

UDP 会发送 `agent busy\n` 这样的文本指令。PetDesktop 也兼容 UDP，但不会保留 HTTP 那种实例身份头。

### USB 串口

```bash
agent-aura-zcode configure --transport serial --serial-port /dev/ttyACM0 --baud 115200
```

## 常用命令

```bash
agent-aura-zcode status
agent-aura-zcode status --probe
agent-aura-zcode discover
agent-aura-zcode discover --save
agent-aura-zcode command "rgb 255,0,0"
agent-aura-zcode command "effect rainbow"
agent-aura-zcode disable
agent-aura-zcode enable
agent-aura-zcode uninstall-hooks
```

配置文件默认写入 `~/.zcode/agent-aura-zcode.json`。

## 控制命令（ZCode 内）

插件提供三个 slash 命令（插件命令带插件名命名空间前缀）：

| 命令 | 作用 |
| :--- | :--- |
| `/agent-aura-zcode:aura on` | 启用状态同步 |
| `/agent-aura-zcode:aura off` | 暂停状态同步（hooks 静默） |
| `/agent-aura-zcode:aura <state>` | 点亮一次指定状态灯效 |
| `/agent-aura-zcode:aura cmd <指令>` | 发送原始固件指令 |
| `/agent-aura-zcode:aura status` | 查看配置并探测设备 |
| `/agent-aura-zcode:setup` | 引导安装与初始化 |
| `/agent-aura-zcode:status` | 检查配置和设备状态 |

示例：`/agent-aura-zcode:aura busy`、`/agent-aura-zcode:aura cmd rgb 255,0,0`。`<state>` 可取 `busy` / `waiting` / `idle` / `running` / `error` / `init` / `offline`。

`/agent-aura-zcode:aura busy` 会执行插件 CLI 的 `test busy` 分支。串口/UDP 配置下最终发送给固件的是文本指令 `agent busy\n`；HTTP 配置下则调用 `POST /api/agent?state=busy`。

> ZCode 插件命令必须带插件名命名空间。请使用 `/agent-aura-zcode:aura ...`，裸 `/aura` 不会被插件注册。

## 配置文件

查看路径：

```bash
agent-aura-zcode config path
```

示例内容见 [agent-aura-zcode.config.example.json](agent-aura-zcode.config.example.json)。

环境变量也可临时覆盖：

```bash
AGENTAURA_ZCODE_CONFIG=/path/to/agent-aura-zcode.json
AGENTAURA_ZCODE_TRANSPORT=http
AGENTAURA_ZCODE_HOST=127.0.0.1
AGENTAURA_ZCODE_PORT=47831
AGENTAURA_ZCODE_AUTH_TOKEN=
```

也兼容通用变量 `AGENTAURA_HOST`、`AGENTAURA_TRANSPORT`、`AGENTAURA_AUTH_TOKEN`。

### 路径变量优先级

CLI 与 PetDesktop 使用同一套路径解析规则（空环境变量视为未设置）：

| 用途 | 优先级 |
| :--- | :--- |
| ZCode 目录 | `ZCODE_HOME` > `ZCODE_CODE_HOME` > `~/.zcode` |
| 配置文件 hooks（辅助） | `ZCODE_CONFIG` > `<ZCode 目录>/cli/config.json` |
| 插件配置 | `AGENTAURA_ZCODE_CONFIG` > `<ZCode 目录>/agent-aura-zcode.json` |
| 运行时状态 | `AGENTAURA_ZCODE_STATE` > `ZCODE_PLUGIN_DATA/state.json` > `<ZCode 目录>/agent-aura-zcode-state.json` |

## Hooks 安装方式

插件自带的 `hooks/hooks.json` 会在 ZCode 加载插件时自动注册，**无需额外安装 hooks**。

如果需要把 hooks 写入 ZCode 配置文件（`~/.zcode/cli/config.json`）作为辅助路径，可使用：

```bash
agent-aura-zcode install-hooks
agent-aura-zcode hooks print
agent-aura-zcode uninstall-hooks
```

说明：
- `install-hooks`：把本插件管理的 hooks 写入 `~/.zcode/cli/config.json` 的 `hooks.events` 字段，并设置 `hooks.enabled: true`。
- `hooks print`：只打印将写入的 hooks JSON 片段，不修改文件。
- `uninstall-hooks`：只删除本插件写入的命名 hook 项，不影响其它 ZCode 配置或其它 hooks。

写入的每个 hook 项包含：
- `timeout`：单位是**秒**，本插件写入 `5`（5 秒），足够 Node 启动并完成一次 HTTP 同步。
- `env`：注入 `AGENTAURA_ZCODE_HOOK=1`。
- `shell`：Windows 上为 `powershell`，其它平台为 `bash`，由 ZCode 显式选择解释器。
- `command`：使用绝对 Node 路径与入口路径，并对空格、单引号做转义。Windows 使用 PowerShell 调用运算符，例如：

```powershell
& 'C:\Program Files\nodejs\node.exe' 'C:\Users\me\.zcode\cli\plugins\agent-aura-zcode\0.3.0\out\index.js' hook 'SessionStart'
```

POSIX 使用 bash：

```bash
'/usr/local/bin/node' '/home/me/.zcode/cli/plugins/agent-aura-zcode/0.3.0/out/index.js' hook 'SessionStart'
```

## 工作方式

插件通过 hooks 自动把 ZCode 生命周期状态同步到环形灯（见上方状态映射）。设备离线时 hook 静默跳过，不影响 ZCode。

- HTTP：发送状态调用 `POST /api/agent?state=<state>`（固件）或 `POST /api/v1/agents/<id>/state`（PetDesktop）；发送原始指令调用 `POST /api/cmd`。
- UDP：直接发送文本指令，例如 `agent busy\n`。
- USB 串口：通过 CDC 串口发送同样的文本指令。

连接 PetDesktop 时，插件会注册 agent 实例、维持心跳、并在工具事件时发送桌宠气泡消息摘要（如"正在运行 Bash"、"Bash 等待授权"、"Bash 已完成"、"任务已完成"）。

## 排障

### 命令不可用

- 运行 `/reload-plugins` 或重启 ZCode 会话。
- 在 **Settings → Plugin Management** 确认 `agent-aura-zcode` 状态为 enabled。
- 确认 `hooks/hooks.json` 已加载（插件详情页应显示 7 个 hook）。

### 插件安装失败或重装后命令仍不出现

ZCode 插件缓存目录可能因异常退出、版本升级或手动清理而损坏，表现为安装记录存在但文件缺失。

1. **完全退出 ZCode**（含托盘 / 后台进程）后重新启动。
2. 检查缓存目录是否存在：
   ```bash
   ls ~/.zcode/cli/plugins/cache/agent-aura-zcode/agent-aura-zcode/0.3.0/
   ```
   如果目录为空或不存在，说明缓存损坏。
3. 在 **Settings → Plugin Management → Installed** 卸载插件，然后到 **Discover** 重新点 **Get** 安装。
4. 确认 marketplace 源路径正确：
   ```bash
   agent-aura-zcode plugin-path
   ```
   输出的 `pluginPath` 应指向 npm 全局包目录，且 `marketplaceReady: true`。
5. 如果 `plugin-path` 报 `marketplaceReady: false`，重新全局安装：
   ```bash
   npm install -g agent-aura-zcode-<version>.tgz
   ```

### 桌宠 / 灯效不随操作变化（hooks 未生效）

插件自带的 `hooks/hooks.json` 通常会在 ZCode 加载插件时自动注册。但在以下情况下可能不会自动生效：清理 `config.json` 后重装、从旧版本升级、或 ZCode 未完全重启。

1. 确认 hook 映射：
   ```bash
   agent-aura-zcode hooks
   ```
2. 检查 ZCode 配置文件中 hooks 是否已注册：
   ```bash
   # 应输出 7 个事件；若为空则需手动安装
   node -e "const d=require('/home/'+require('os').userInfo().username+'/.zcode/cli/config.json');console.log(Object.keys(d?.hooks?.events||{}).length)"
   ```
3. 如果 hooks 未自动注册，运行兜底命令写入 `config.json`：
   ```bash
   agent-aura-zcode install-hooks
   ```
4. **完全退出 ZCode 后重启**，让新写入的 hooks 配置生效。

### 灯不亮

- 运行 `agent-aura-zcode status --probe` 检查设备连通性与配置。
- 运行 `agent-aura-zcode test busy` 手动测试灯效。
- 确认 `host` 和 `port` 与实际设备一致。
- 查看 ZCode 的 debug 日志，hook 的 `[agentaura]` stderr 会显示事件与同步结果。

### 串口无响应

- 确认 `serial_port=/dev/ttyACM0` 与实际设备一致。
- Linux 下确认当前用户在 `dialout` 组，或当前 shell 具备访问该串口的权限。
- 使用 `agent-aura-zcode command state` 探测设备。

### 日志中出现 ENOENT: stat '.../commands/aura.md' 警告

这是 ZCode 解析 `marketplace.json` 的 `source` 字段时的已知行为——它将 `"source": "."` 相对路径解析为当前工作区目录，而非插件缓存目录。该警告**不影响插件功能**（命令仍能正常加载和执行），可安全忽略。

## 本地开发与排障

```bash
cd Agent_Plugin/agent-aura-zcode
npm install
npm run build
npm test
```

从源码目录可用 `--plugin-dir` 临时加载插件：

```bash
zcode --plugin-dir Agent_Plugin/agent-aura-zcode
```

内置 CLI 仅用于排障与手动测试：

```bash
node out/index.js configure --discover     # 发现并保存设备
node out/index.js test busy                # 测试灯效
node out/index.js discover                 # 扫描设备
node out/index.js status --probe           # 查看配置并探测 /api/state
node out/index.js command "rgb 255,0,0"    # 发送固件指令
node out/index.js config init              # 生成默认配置文件
```

CLI 配置文件位于 `~/.zcode/agent-aura-zcode.json`，示例见 [agent-aura-zcode.config.example.json](agent-aura-zcode.config.example.json)。环境变量可临时覆盖，例如 `AGENTAURA_ZCODE_HOST`、`AGENTAURA_ZCODE_TRANSPORT`，也兼容通用变量 `AGENTAURA_HOST`、`AGENTAURA_TRANSPORT`。
