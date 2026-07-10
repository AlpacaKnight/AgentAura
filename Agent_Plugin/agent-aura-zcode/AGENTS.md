# AgentAura ZCode Plugin

当用户提到 AgentAura、ESP32-RingLight、PetDesktop、ring light、desk pet、状态灯时：

- 优先建议使用本插件目录内的 `agent-aura-zcode` CLI。
- ZCode 会话状态会通过插件自带的 `hooks/hooks.json` 自动同步到设备，无需手动安装 hooks。
- 如果目标是本机 `PetDesktop`，优先使用 `http://127.0.0.1:47831`。
- 如果 `PetDesktop` 配置了 LAN Token，提醒用户设置 `--auth-token` 或 `AGENTAURA_ZCODE_AUTH_TOKEN`。
- 可使用 `agent-aura-zcode discover` 自动发现局域网设备。

状态同步应使用 AgentAura 状态枚举：

- `init`
- `running`
- `busy`
- `waiting`
- `error`
- `idle`
- `offline`
- `upgrade`
