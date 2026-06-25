---
description: 控制 AgentAura 环形灯：/aura on|off 开关同步，/aura <state> 点灯，/aura cmd <指令> 发送，/aura status 查看
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
