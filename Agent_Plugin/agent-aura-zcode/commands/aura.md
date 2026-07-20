---
description: "控制 AgentAura 环形灯：/agent-aura-zcode:aura on|off 开关同步，点灯，发送固件指令，查看状态"
argument-hint: [on|off|status|cmd <raw>|<state>]
allowed-tools: Bash(sh:*)
---

AgentAura 控制结果：

!`sh "${ZCODE_PLUGIN_ROOT}/bin/aura-dispatch.sh" "${ZCODE_PLUGIN_ROOT}" $ARGUMENTS`

用法：
- `/agent-aura-zcode:aura on` / `off`：启用或暂停状态同步（写入禁用标记，hooks 据此静默）。
- `/agent-aura-zcode:aura <state>`：点亮一次灯效，`<state>` 取 `busy` / `waiting` / `idle` / `running` / `error` / `init` / `offline`。
- `/agent-aura-zcode:aura cmd <指令>`：发送原始固件指令，如 `/agent-aura-zcode:aura cmd rgb 255,0,0`。
- `/agent-aura-zcode:aura status`：查看配置并探测设备。

例如 `/agent-aura-zcode:aura busy` 会走 `test busy`，串口/UDP 下发送 `agent busy\n`，HTTP 下调用 `POST /api/agent?state=busy`。

ZCode 插件命令必须带插件名命名空间；裸 `/aura` 不会被插件注册。

排障：如果灯效不随操作变化，可能是 hooks 未注册。运行 `/agent-aura-zcode:aura status` 查看运行状态，或在终端执行 `agent-aura-zcode install-hooks` 将 hooks 写入 `config.json`，然后完全重启 ZCode。
