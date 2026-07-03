# AgentAura Qwen Code Setup

为当前环境安装并初始化 `agent-aura-qwencode`。

按下面顺序执行：

1. 先确认 `agent-aura-qwencode` 命令已安装并可执行
2. 运行 `agent-aura-qwencode config init`
3. 如果目标是本机 PetDesktop，运行 `agent-aura-qwencode configure --transport http --host 127.0.0.1 --port 47831 --auto-discover false`
4. 如果目标是局域网设备，先运行 `agent-aura-qwencode discover`，再按发现结果执行 `configure`
5. 最后运行 `agent-aura-qwencode install-hooks`
6. 完全退出并重新启动 Qwen Code，让新 hooks 生效

完成后，额外执行：

- `agent-aura-qwencode status`
- 如果需要连通性检查，再执行 `agent-aura-qwencode status --probe`

如果当前机器还没安装 CLI，请先安装打包产物：

- `npm install -g agent-aura-qwencode-<version>.tgz`
- `qwen extensions install agent-aura-qwencode-<version>.zip`
