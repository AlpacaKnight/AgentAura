# Uninstall AgentAura Hooks

移除 `agent-aura-qwencode` 写入的 Qwen Code hooks。

执行：

1. `cd Agent_Plugin/agent-aura-qwencode`
2. `node out/index.js uninstall-hooks`
3. `node out/index.js hooks print`

说明：只删除 `agent-aura-qwencode:` 前缀的 hook 项，不影响其他 Qwen 配置。
