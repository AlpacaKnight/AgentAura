# AgentAura Qwen Code Status

检查 `agent-aura-qwencode` 当前配置和设备状态。

依次执行：

1. `agent-aura-qwencode status`
2. `agent-aura-qwencode status --probe`

如果发现配置为空或目标不可达：

- 本机 PetDesktop 使用 `agent-aura-qwencode configure --transport http --host 127.0.0.1 --port 47831 --auto-discover false`
- 局域网设备先运行 `agent-aura-qwencode discover`
- 需要重写 hooks 时运行 `agent-aura-qwencode install-hooks`
