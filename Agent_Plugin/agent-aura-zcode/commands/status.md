# AgentAura ZCode Status

检查 `agent-aura-zcode` 当前配置和设备状态。

依次执行：

1. `agent-aura-zcode status`
2. `agent-aura-zcode status --probe`

如果发现配置为空或目标不可达：

- 本机 PetDesktop 使用 `agent-aura-zcode configure --transport http --host 127.0.0.1 --port 47831 --auto-discover false`
- 局域网设备先运行 `agent-aura-zcode discover`
- 需要写入配置文件 hooks 时运行 `agent-aura-zcode install-hooks`（插件自带 hooks 通常已足够）
