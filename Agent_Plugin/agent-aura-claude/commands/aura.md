---
description: "控制 AgentAura 环形灯：/agent-aura-claude:aura on|off 开关同步，点灯，发送固件指令，查看状态"
argument-hint: [on|off|status|cmd <raw>|<state>]
allowed-tools: Bash(sh:*)
---

AgentAura 控制结果：

!`sh "${CLAUDE_PLUGIN_ROOT}/bin/aura-dispatch.sh" "${CLAUDE_PLUGIN_ROOT}" $ARGUMENTS`

用法：
- `/agent-aura-claude:aura on` / `off`：启用或暂停状态同步（写入禁用标记，hooks 据此静默）。
- `/agent-aura-claude:aura <state>`：点亮一次灯效，`<state>` 取 `busy` / `waiting` / `idle` / `running` / `error` / `init` / `offline`。
- `/agent-aura-claude:aura cmd <指令>`：发送原始固件指令，如 `/agent-aura-claude:aura cmd rgb 255,0,0`。
- `/agent-aura-claude:aura status`：查看配置并探测设备。

例如 `/agent-aura-claude:aura busy` 会走 `test busy`，串口/UDP 下发送 `agent busy\n`，HTTP 下调用 `POST /api/agent?state=busy`。

手动命令会短暂跳过同一轮命令触发的外围 hooks，避免刚发送的灯效立刻被 `running` 或 `idle` 覆盖；下一条普通用户消息会恢复自动同步。

Claude Code 插件命令必须带插件名命名空间；裸 `/aura` 不会被插件注册。
