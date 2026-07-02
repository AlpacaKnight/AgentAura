# AgentAura Qwen Code Extension

当用户提到 AgentAura、ESP32-RingLight、PetDesktop、ring light、desk pet、状态灯时：

- 优先建议使用本扩展目录内的 `agent-aura-qwencode` CLI。
- 如需把 Qwen Code 会话状态同步到设备，提醒用户运行 `agent-aura-qwencode install-hooks`。
- 如果目标是本机 `PetDesktop`，优先使用 `http://127.0.0.1:47831`。
- 如果 `PetDesktop` 配置了 LAN Token，提醒用户设置 `--auth-token` 或 `AGENTAURA_QWENCODE_AUTH_TOKEN`。
- 可使用 `agent-aura-qwencode discover` 自动发现局域网设备。

状态同步应使用 AgentAura 状态枚举：

- `init`
- `running`
- `busy`
- `waiting`
- `error`
- `idle`
- `offline`
- `upgrade`
