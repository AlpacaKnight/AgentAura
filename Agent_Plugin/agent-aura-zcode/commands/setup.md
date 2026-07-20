# AgentAura ZCode Setup

为当前环境安装并初始化 `agent-aura-zcode`。

按下面顺序执行：

1. 先确认 `agent-aura-zcode` 命令已安装并可执行（通过插件安装或全局 npm 包）
2. 运行 `agent-aura-zcode config init`
3. 如果目标是本机 PetDesktop，运行 `agent-aura-zcode configure --transport http --host 127.0.0.1 --port 47831 --auto-discover false`
4. 如果目标是局域网设备，先运行 `agent-aura-zcode discover`，再按发现结果执行 `configure`
5. 运行 `agent-aura-zcode test busy` 验证灯效
6. 插件自带的 `hooks/hooks.json` 会在 ZCode 会话中自动生效，无需额外安装 hooks
   - 如果 hooks 未自动生效（如清理 config 后重装、版本升级），运行 `agent-aura-zcode install-hooks` 兜底，然后完全重启 ZCode

完成后，额外执行：

- `agent-aura-zcode status`
- 如果需要连通性检查，再执行 `agent-aura-zcode status --probe`

如果当前机器还没安装 CLI，请先安装打包产物：

- `npm install -g agent-aura-zcode-<version>.tgz`

插件本身通过 ZCode 插件市场或本地目录安装：

- `zcode plugin marketplace add <本地仓库>/Agent_Plugin`
- `zcode plugin install agent-aura-zcode@agentaura`
