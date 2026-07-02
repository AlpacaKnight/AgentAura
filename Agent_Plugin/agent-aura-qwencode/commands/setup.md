# AgentAura Qwen Code Setup

为当前环境安装并初始化 `agent-aura-qwencode`。

按下面顺序执行：

1. 进入 `Agent_Plugin/agent-aura-qwencode`
2. 运行 `npm install`
3. 运行 `npm run compile`
4. 运行 `node out/index.js config init`
5. 如果目标是本机 PetDesktop，运行 `node out/index.js configure --transport http --host 127.0.0.1 --port 47831`
6. 如果目标是局域网设备，先运行 `node out/index.js discover`，再按发现结果执行 `configure`
7. 最后运行 `node out/index.js install-hooks`

完成后，额外执行：

- `node out/index.js status`
- 如果需要连通性检查，再执行 `node out/index.js status --probe`
