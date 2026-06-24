---
name: agent-aura-codex
description: '用于 AgentAura Codex 插件的安装、打包、配置、启用、关闭、卸载和排障。触发词：AgentAura Codex、Codex hooks、ESP32 环形灯、HTTP/UDP/serial 串口连接、配置文件、pack.sh 权限、status、test、off/on、uninstall、package。'
argument-hint: '安装 | 配置 http/udp/serial | hooks | 状态 | 开关 | 卸载 | 打包'
---

# AgentAura Codex

这个 skill 用于处理 AgentAura Codex 插件的重复性操作：打包插件、全局安装、配置 ESP32 环形灯连接、安装 Codex hooks、测试状态同步、开关同步，以及干净卸载。

## 适用场景

- 用户询问如何安装或使用 AgentAura Codex 插件。
- 用户要配置 HTTP、UDP 或 USB 串口连接到 ESP32 环形灯。
- 用户询问 `configure --discover` 为什么失败，或需要手动配置连接。
- 用户询问 Codex hook 同步机制，或想确认 hooks 是否安装。
- 用户想临时关闭同步、重新开启同步、移除 hooks 或卸载插件。
- 用户遇到 `./scripts/pack.sh: Permission denied` 或 `权限不够`。

## 关键路径

- 插件目录：`Agent_Plugin/agent-aura-codex`
- 配置文件：`~/.codex/agent-aura-codex.json`
- 禁用标记：`~/.codex/agent-aura-codex.disabled`
- Codex hooks 文件：`~/.codex/hooks.json`
- 打包产物：`Agent_Plugin/agent-aura-codex/dist/agent-aura-codex-0.1.0.tgz` 和 `.zip`
- 命令速查：[commands.md](./references/commands.md)

## 操作流程

1. 本地命令先进入插件目录：

   ```bash
   cd /home/xuyd2/Git/open/AgentAura/Agent_Plugin/agent-aura-codex
   ```

2. 如需重新构建或打包，运行：

   ```bash
   npm install
   npm run compile
   ./scripts/pack.sh
   ```

   如果直接执行脚本提示权限不足，运行：

   ```bash
   chmod +x scripts/pack.sh
   ./scripts/pack.sh
   ```

   也可以使用 `bash scripts/pack.sh`，这种方式不需要执行权限。

3. 全局安装打包后的 CLI：

   ```bash
   npm install -g ./dist/agent-aura-codex-0.1.0.tgz
   ```

4. 初始化或查看配置文件：

   ```bash
   agent-aura-codex config init
   agent-aura-codex config path
   agent-aura-codex config get
   ```

5. 配置连接。优先尝试 HTTP 自动发现：

   ```bash
   agent-aura-codex configure --discover
   ```

   如果发现失败，手动配置一种连接方式：

   ```bash
   agent-aura-codex configure --transport http --host 192.168.1.100 --port 80
   agent-aura-codex configure --transport udp --host 192.168.1.100 --port 8888
   agent-aura-codex configure --transport serial --serial-port /dev/ttyACM0 --baud 115200
   ```

6. Linux 串口配置时，先枚举可能的设备：

   ```bash
   ls -1 /dev/ttyACM* /dev/ttyUSB* 2>/dev/null || true
   ```

   如果串口访问失败，提示用户检查 `dialout` 组：

   ```bash
   sudo usermod -aG dialout "$USER"
   ```

   修改用户组后需要注销并重新登录，或重启当前终端会话。

7. 配置连接后安装 Codex hooks：

   ```bash
   agent-aura-codex install-hooks
   ```

   提醒用户新开一个 Codex 会话或重启 Codex，让它重新读取 `~/.codex/hooks.json`。

8. 验证行为：

   ```bash
   agent-aura-codex status
   agent-aura-codex status --probe
   agent-aura-codex test busy
   agent-aura-codex test waiting
   agent-aura-codex test idle
   ```

9. 不移除 hooks 的情况下关闭或恢复同步：

   ```bash
   agent-aura-codex off
   agent-aura-codex on
   ```

   `off` 会创建 `~/.codex/agent-aura-codex.disabled`；之后 hooks 会 no-op，不再发送任何灯光信号。

10. 用户要求完整卸载时，按顺序执行：

    ```bash
    agent-aura-codex uninstall-hooks
    npm uninstall -g agent-aura-codex
    rm -f ~/.codex/agent-aura-codex.json ~/.codex/agent-aura-codex-state.json ~/.codex/agent-aura-codex.disabled
    ```

## Hook 映射

- `UserPromptSubmit` -> `agent running`
- `PreToolUse` -> `agent busy`
- `PostToolUse` -> `agent running`
- `PermissionRequest` -> `agent waiting`
- `Stop` -> `agent idle`

## 安全注意

- 不要手动覆盖 `~/.codex/hooks.json`；使用 `agent-aura-codex install-hooks` 或 `uninstall-hooks`，这样会保留其它插件 hooks。
- 如果需要验证流程但不能触碰真实 Codex 配置，用临时 `CODEX_HOME`，例如 `CODEX_HOME=$(mktemp -d) agent-aura-codex config init`。
- 如果没有硬件连接，不要声称运行态验证成功；只报告配置状态，并建议用户连接设备后运行 `test busy` 或 `status --probe`。
