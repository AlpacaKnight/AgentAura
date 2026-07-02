# AgentAura Qwen Code Status

检查 `agent-aura-qwencode` 当前配置和设备状态。

依次执行：

1. `cd Agent_Plugin/agent-aura-qwencode`
2. `node out/index.js status`
3. `node out/index.js status --probe`

如果发现配置为空或目标不可达：

- 本机 PetDesktop 使用 `node out/index.js configure --transport http --host 127.0.0.1 --port 47831`
- 局域网设备先运行 `node out/index.js discover`
